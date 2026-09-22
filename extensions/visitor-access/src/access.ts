import type { PluginRuntime } from "../api.js";
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
};

type VisitorGatewayAccess = {
  describe: (email: string) => string;
  assertInvitable: (email: string) => void;
};

export type ReadVisitorGatewayAccess = () => Promise<VisitorGatewayAccess>;

export function createVisitorAccessReader(
  runtime: Pick<PluginRuntime, "gateway" | "config">,
): ReadVisitorGatewayAccess {
  return async () => {
    const { profiles } = await runtime.gateway.request<{ profiles: VisitorProfile[] }>(
      "users.list",
      {},
      { scopes: ["operator.read"] },
    );
    // The profile directory owns verified aliases, including linked identities.
    // A supplied GitHub login is invitation metadata, never an identity binding.
    const byEmail = new Map(
      profiles.flatMap((profile) => profile.emails.map((email) => [email, profile] as const)),
    );
    const config = runtime.config.current();
    const roles = config.gateway?.roles;
    const access = (email: string) => describeAccess(byEmail.get(email), roles);
    return {
      describe: (email) => access(email).description,
      assertInvitable(email) {
        resolveVisitorRole(config);
        const result = access(email);
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
