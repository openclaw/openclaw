import type { PluginRuntime } from "../api.js";
import type { VisitorTarget } from "./cloudflare.js";
import { VisitorAccessError } from "./errors.js";
import {
  isRestrictedVisitorRole,
  profileUsesVisitorRole,
  resolveVisitorRole,
  type GatewayRoles,
} from "./roles.js";

type VisitorProfile = {
  id: string;
  emails: string[];
  role?: string;
  mergedInto?: string | null;
  githubIdentity?: { login: string } | null;
};

type VisitorGatewayAccess = {
  describe: (target: VisitorTarget) => string;
  githubLogin: (target: VisitorTarget) => string | undefined;
  assertGithubSelection: (login: string, accountId: number) => void;
  assertInvitable: (target: VisitorTarget) => void;
  profileId: (target: VisitorTarget) => string | undefined;
  resolveProfile: (profileId: string) => VisitorProfile | undefined;
  withProfile: <T>(
    profileId: string,
    targets: readonly VisitorTarget[],
    run: (assertCurrent: () => void) => Promise<T>,
  ) => Promise<T>;
};

export type ReadVisitorGatewayAccess = (
  githubAccountIds?: readonly number[],
) => Promise<VisitorGatewayAccess>;

export function createVisitorAccessReader(
  runtime: Pick<PluginRuntime, "gateway" | "config">,
): ReadVisitorGatewayAccess {
  return async (githubAccountIds = []) => {
    const { profiles, githubProfiles } = await runtime.gateway.request<{
      profiles: VisitorProfile[];
      githubProfiles?: Array<{ accountId: number; profileId: string }>;
    }>(
      "users.list",
      githubAccountIds.length ? { githubAccountIds: [...new Set(githubAccountIds)] } : {},
      { scopes: ["operator.read"] },
    );
    const canonical = profiles.filter((profile) => !profile.mergedInto);
    const byEmail = new Map(
      canonical.flatMap((profile) => profile.emails.map((email) => [email, profile] as const)),
    );
    const byId = new Map(canonical.map((profile) => [profile.id, profile]));
    const byGithub = new Map(
      githubProfiles?.map(({ accountId, profileId }) => [accountId, byId.get(profileId)]),
    );
    const profile = (target: VisitorTarget) =>
      typeof target === "string" ? byEmail.get(target) : byGithub.get(target);
    const config = runtime.config.current();
    const roles = config.gateway?.roles;
    const access = (target: VisitorTarget) => describeAccess(profile(target), roles);
    return {
      describe: (target) => access(target).description,
      githubLogin: (target) => profile(target)?.githubIdentity?.login,
      assertGithubSelection(login, accountId) {
        const normalized = login.toLowerCase();
        const matches = canonical.filter(
          (entry) => entry.githubIdentity?.login.toLowerCase() === normalized,
        );
        if (matches.length > 1 || (matches[0] && matches[0].id !== profile(accountId)?.id)) {
          throw new VisitorAccessError(
            "The GitHub login conflicts with the Gateway's verified profile. Use a current profileId, grantId, or exact invitation email.",
          );
        }
      },
      profileId: (target) => profile(target)?.id,
      resolveProfile: (profileId) => byId.get(profileId),
      withProfile(profileId, targets, run) {
        const withIdentity = runtime.gateway.withUserProfileIdentity;
        if (!withIdentity) {
          throw new VisitorAccessError(
            "This Gateway cannot keep profile bindings current. Update OpenClaw before person-wide revocation.",
          );
        }
        return withIdentity(
          {
            profileId,
            emails: targets.filter((target) => typeof target === "string"),
            githubAccountIds: targets.filter((target) => typeof target === "number"),
          },
          run,
        );
      },
      assertInvitable(target) {
        resolveVisitorRole(config);
        const result = access(target);
        if (!result.invitable) {
          throw new VisitorAccessError(
            `${result.description}. Configure a default role with isolated own-session work and shared-session viewing before inviting this person.`,
          );
        }
      },
    };
  };
}

function describeAccess(
  profile: VisitorProfile | undefined,
  roles: GatewayRoles,
): { invitable: boolean; description: string } {
  if (profile && !profileUsesVisitorRole(roles, profile)) {
    return {
      invitable: true,
      description:
        profile.id === "gateway-owner"
          ? "Gateway access: shared owner authority retained; this invitation does not restrict it"
          : `Gateway access: existing role ${JSON.stringify(profile.role)} retained; this invitation does not restrict it`,
    };
  }
  if (!roles) {
    return { invitable: false, description: "Gateway access is unrestricted: roles are disabled" };
  }
  const assignedRole =
    profile?.role && Object.hasOwn(roles.definitions, profile.role) ? profile.role : undefined;
  const roleName = assignedRole ?? roles.default;
  const role =
    roleName && Object.hasOwn(roles.definitions, roleName)
      ? roles.definitions[roleName]
      : undefined;
  if (!role) {
    return {
      invitable: false,
      description: `Gateway access could not be verified: default role ${JSON.stringify(roleName ?? "")} is unavailable`,
    };
  }
  const source = assignedRole ? "assigned" : "default";
  const identity = !profile
    ? "; first sign-in pending"
    : profile.role && !assignedRole
      ? `; unavailable assignment ${JSON.stringify(profile.role)}`
      : "";
  if (isRestrictedVisitorRole(role)) {
    return {
      invitable: true,
      description: `Gateway access: restricted guest (${source} role ${JSON.stringify(roleName)}${identity})`,
    };
  }
  return {
    invitable: false,
    description: `Gateway default role ${JSON.stringify(roleName)} does not provide restricted guest access`,
  };
}
