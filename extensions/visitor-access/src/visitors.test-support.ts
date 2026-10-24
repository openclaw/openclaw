import { randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, vi } from "vitest";
import type { PluginRuntime, PluginStateKeyedStore } from "../api.js";
import { createVisitorAccessReader } from "./access.js";
import { VisitorPolicyClient, type VisitorTarget } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import type { VisitorGrant } from "./grant-record.js";
import { VisitorAccessService } from "./visitors.js";

export const NOW = Date.parse("2026-08-28T12:00:00.000Z");
export const DAY_MS = 86_400_000;
const services = new Set<VisitorAccessService>();

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected visitor fixture operation");
};

export function useVisitorFixtures() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    closeVisitorFixtures();
    vi.useRealTimers();
  });
}

export function visitorGate() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

export function closeVisitorFixtures(): void {
  services.forEach((service) => service.close());
  services.clear();
}

export const visitorConfig: VisitorAccessConfig = {
  accountId: "test-account",
  appId: "test-app",
  apiToken: "test-token",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const policiesPath = "/client/v4/accounts/test-account/access/apps/test-app/policies";
export const githubProvider = {
  issuer: "https://example.cloudflareaccess.com",
  providerId: "github-provider",
  githubAccountIdClaim: "github_account_id",
};
export const githubRule = {
  oidc: {
    identity_provider_id: githubProvider.providerId,
    claim_name: githubProvider.githubAccountIdClaim,
    claim_value: "42",
  },
};
export type GatewayRoles = NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
export const guestRole: GatewayRoles["definitions"][string] = {
  accessPolicyPlugin: "visitor-access",
  sessions: { others: "view" },
  agents: ["main"],
  scopes: ["operator.sessions.write"],
  sandbox: "required",
  modelPolicy: {},
};
export const staffRole: GatewayRoles["definitions"][string] = {
  sessions: { others: "write" },
  agents: "*",
  scopes: ["operator.admin"],
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

type PolicyFixture = ReturnType<typeof namedPolicy>;

export function namedPolicy(
  targets: VisitorTarget[] = ["first@example.com"],
  name = visitorConfig.policyName,
  provider = githubProvider,
) {
  const oidc = {
    identity_provider_id: provider.providerId,
    claim_name: provider.githubAccountIdClaim,
  };
  return {
    id: "visitors",
    name,
    decision: "allow",
    include: targets.map((target) =>
      typeof target === "string"
        ? { email: { email: target } }
        : { oidc: { ...oidc, claim_value: String(target) } },
    ),
  };
}

type GrantOverrides = Partial<Omit<VisitorGrant, "email" | "githubAccountId">>;

export function visitorGrant(
  email: string,
  overrides?: GrantOverrides,
): VisitorGrant & { email: string };
export function visitorGrant(
  githubAccountId: number,
  overrides?: GrantOverrides,
): VisitorGrant & { githubAccountId: number };
export function visitorGrant(target: VisitorTarget, overrides: GrantOverrides = {}): VisitorGrant {
  return {
    grantId: randomUUID(),
    ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
    createdAt: NOW - DAY_MS,
    expiresAt: NOW + DAY_MS,
    ...overrides,
  };
}

export type ProfileFixture = {
  id: string;
  emails: readonly string[];
  role?: string;
  effectiveRole?: string;
  roleSource?: "assigned" | "githubLogin" | "default";
  mergedInto?: string | null;
  githubIdentity?: { host?: string; login: string } | null;
};

export function visitorProfileFixture(
  initial: ProfileFixture[] = [],
  githubProfiles: Array<{ accountId: number; profileId: string }> = [],
) {
  let profiles = initial;
  const response = async (method: string, params?: Record<string, unknown>) => {
    if (method !== "users.list") {
      throw new Error("Unexpected Gateway request");
    }
    const requested = params?.githubAccountIds;
    return {
      profiles,
      ...(Array.isArray(requested)
        ? {
            githubProfiles: githubProfiles.filter(({ accountId }) => requested.includes(accountId)),
          }
        : {}),
    };
  };
  const withUserProfileIdentity: NonNullable<
    PluginRuntime["gateway"]["withUserProfileIdentity"]
  > = async ({ profileId, emails, githubAccountIds }, run) => {
    const assertCurrent = () => {
      const profile = profiles.find(({ id }) => id === profileId);
      const linkedAccounts = new Set(
        githubProfiles
          .filter((identity) => identity.profileId === profileId)
          .map((identity) => identity.accountId),
      );
      if (
        !profile ||
        emails.some((email) => !profile.emails.includes(email)) ||
        githubAccountIds?.some((accountId) => !linkedAccounts.has(accountId))
      ) {
        throw new Error("Profile bindings changed");
      }
    };
    assertCurrent();
    return await run(assertCurrent);
  };
  const gateway: PluginRuntime["gateway"] = {
    isAvailable: async () => true,
    request: unexpected,
    subscribeSessionChanges() {
      throw new Error("Unexpected session change subscription");
    },
    readSessionFacts: unexpected,
    withSessionFacts: unexpected,
    appendAgentMessage: unexpected,
    openPluginPanel: unexpected,
    withUserProfileIdentity,
    resolveGitHubAccount: async ({ login }) => ({ accountId: 42, login }),
  };
  const request = vi.spyOn(gateway, "request").mockImplementation(response);
  return {
    gateway,
    request,
    setProfiles(this: void, next: ProfileFixture[]) {
      profiles = next;
      request.mockImplementation(response);
    },
  };
}

export function visitorFixture(
  options: {
    config?: Partial<VisitorAccessConfig>;
    grants?: VisitorGrant[];
    emails?: string[];
    githubAccountIds?: number[];
    githubAccountId?: number;
    githubLogin?: string;
    gatewayConfig?: OpenClawConfig;
    profiles?: ProfileFixture[];
    githubProfiles?: Array<{ accountId: number; profileId: string }>;
    store?: PluginStateKeyedStore<VisitorGrant>;
    gateway?: PluginRuntime["gateway"];
  } = {},
) {
  const resolved = { ...visitorConfig, ...options.config };
  const oidcProvider =
    options.gatewayConfig?.gateway?.auth?.trustedProxy?.cloudflareAccessOidc ?? githubProvider;
  const grants = new Map(
    options.grants?.map((grant) => [
      "email" in grant ? grant.email : `github:${grant.githubAccountId}`,
      grant,
    ]),
  );
  const targets: VisitorTarget[] = [...(options.emails ?? []), ...(options.githubAccountIds ?? [])];
  const store: PluginStateKeyedStore<VisitorGrant> = {
    register: async (key, grant) => void grants.set(key, structuredClone(grant)),
    registerIfAbsent: unexpected,
    lookup: async (key) => structuredClone(grants.get(key)),
    consume: unexpected,
    delete: async (key) => grants.delete(key),
    entries: async () =>
      [...grants].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.createdAt,
      })),
    clear: unexpected,
    withCurrent({ assertCurrent }) {
      const bind =
        <Args extends unknown[], Value>(operation: (...args: Args) => Promise<Value>) =>
        (...args: Args): Promise<Value> => {
          assertCurrent();
          return operation(...args);
        };
      return Object.freeze({
        register: bind(store.register.bind(store)),
        registerIfAbsent: unexpected,
        lookup: bind(store.lookup.bind(store)),
        consume: unexpected,
        delete: bind(store.delete.bind(store)),
        entries: bind(store.entries.bind(store)),
        clear: unexpected,
        observe: unexpected,
        compareAndApply: unexpected,
        deleteIfEqual: unexpected,
        lookupMany: unexpected,
        entriesInKeyRange: unexpected,
        moveEntriesFrom: unexpected,
        count: unexpected,
      });
    },
  };
  const cloudflare = {
    policy: targets.length ? namedPolicy(targets, resolved.policyName, oidcProvider) : undefined,
    failWrites: false,
    loseWriteResponse: false,
    beforeWrite: async () => {},
    afterWrite: () => {},
  };
  const response = (result: unknown) => Response.json({ success: true, result });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    const collection = url.pathname === policiesPath;
    const detail = url.pathname === `${policiesPath}/visitors`;
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith(policiesPath)) {
      throw new Error("Unexpected Cloudflare endpoint");
    }
    if (method === "GET") {
      if (!collection && !(detail && cloudflare.policy)) {
        throw new Error("Unknown policy read");
      }
      return response(
        collection ? (cloudflare.policy ? [cloudflare.policy] : []) : cloudflare.policy,
      );
    }
    await cloudflare.beforeWrite();
    if (cloudflare.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (method === "DELETE" && detail) {
      cloudflare.policy = undefined;
    } else if ((method === "POST" && collection) || (method === "PUT" && detail)) {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy");
      }
      const body = JSON.parse(init.body) as Omit<PolicyFixture, "id">;
      cloudflare.policy = { ...body, id: "visitors" };
    } else {
      throw new Error("Unexpected policy mutation");
    }
    if (cloudflare.loseWriteResponse) {
      throw new Error("Connection lost after Cloudflare committed the policy");
    }
    const result = response(cloudflare.policy ?? { id: "visitors" });
    cloudflare.afterWrite();
    return result;
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const gatewayConfig = options.gatewayConfig ?? {
    gateway: { roles: { default: "guest", definitions: { guest: guestRole, staff: staffRole } } },
  };
  const directory = visitorProfileFixture(options.profiles, options.githubProfiles);
  const runtime: Pick<PluginRuntime, "gateway" | "config"> = {
    gateway: options.gateway ?? directory.gateway,
    config: {
      current: () => gatewayConfig,
      mutateConfigFile: unexpected,
      replaceConfigFile: unexpected,
    },
  };
  const resolveGitHubAccount = vi
    .spyOn(runtime.gateway, "resolveGitHubAccount")
    .mockImplementation(async ({ login }) => ({
      accountId: options.githubAccountId ?? 42,
      login: options.githubLogin ?? login.toLowerCase(),
    }));
  const assertCurrent = vi.fn<() => void>();
  const policy = new VisitorPolicyClient(resolved, fetcher, undefined, () => oidcProvider);
  const service = new VisitorAccessService(
    resolved,
    options.store ?? store,
    policy,
    logger,
    createVisitorAccessReader(runtime),
    runtime.gateway.resolveGitHubAccount,
  );
  services.add(service);
  return {
    cloudflare,
    policy,
    fetcher,
    grants,
    resolveGitHubAccount,
    gatewayRequest: directory.request,
    setProfiles: directory.setProfiles,
    logger,
    service,
    authorize: service.authorize.bind(service),
    resume: service.resume.bind(service),
    store,
    authority: { assertCurrent },
    revokeAuthority: () =>
      assertCurrent.mockImplementation(() => {
        throw new Error("Visitor authority is no longer current");
      }),
    invite: (input: unknown) => service.invite(input, { assertCurrent }),
    revoke: (input: unknown) => service.revoke(input, assertCurrent),
    list: () => service.list(assertCurrent),
    emails: () =>
      cloudflare.policy?.include.flatMap((rule) => (rule.email ? [rule.email.email] : [])) ?? [],
    targets: () =>
      cloudflare.policy?.include.map((rule) =>
        rule.email ? rule.email.email : Number(rule.oidc.claim_value),
      ) ?? [],
    mutations: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method !== "GET" && init?.method),
  };
}
