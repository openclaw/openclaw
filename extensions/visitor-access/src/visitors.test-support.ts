import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import type { PluginRuntime, PluginStateKeyedStore } from "../api.js";
import { createVisitorAccessReader } from "./access.js";
import { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessService, type VisitorGrant } from "./visitors.js";

export const NOW = Date.parse("2026-08-28T12:00:00.000Z");
export const DAY_MS = 86_400_000;
const services = new Set<VisitorAccessService>();

export function closeVisitorFixtures(): void {
  for (const service of services) {
    service.close();
  }
  services.clear();
}

const config: VisitorAccessConfig = {
  accountId: "test-account",
  appId: "test-app",
  apiToken: "test-token",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const policiesPath = "/client/v4/accounts/test-account/access/apps/test-app/policies";
export type GatewayRoles = NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
export const guestRole: GatewayRoles["definitions"][string] = {
  accessPolicyPlugin: "visitor-access",
  sessions: { others: "view" },
  agents: ["main"],
  scopes: ["operator.sessions.write"],
  sandbox: "required",
};
export const staffRole: GatewayRoles["definitions"][string] = {
  sessions: { others: "write" },
  agents: "*",
  scopes: ["operator.admin"],
};

export function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

type PolicyFixture = {
  id: string;
  name: string;
  decision: string;
  include: { email: { email: string } }[];
};

export function visitorGrant(email: string, overrides: Partial<VisitorGrant> = {}): VisitorGrant {
  return {
    grantId: randomUUID(),
    email,
    createdAt: NOW - DAY_MS,
    expiresAt: NOW + DAY_MS,
    ...overrides,
  };
}

export function visitorFixture(
  options: {
    config?: Partial<VisitorAccessConfig>;
    grants?: VisitorGrant[];
    emails?: string[];
    githubEmail?: string | null;
    gatewayConfig?: OpenClawConfig;
    profiles?: Array<{ id: string; emails: string[]; role?: string }>;
  } = {},
) {
  const resolved = { ...config, ...options.config };
  const grants = new Map(options.grants?.map((grant) => [grant.email, grant]));
  const store: PluginStateKeyedStore<VisitorGrant> = {
    async register(key, grant) {
      grants.set(key, structuredClone(grant));
    },
    async registerIfAbsent(key, grant) {
      if (grants.has(key)) {
        return false;
      }
      grants.set(key, structuredClone(grant));
      return true;
    },
    async lookup(key) {
      return structuredClone(grants.get(key));
    },
    async consume(key) {
      const grant = grants.get(key);
      grants.delete(key);
      return structuredClone(grant);
    },
    async delete(key) {
      return grants.delete(key);
    },
    async entries() {
      return [...grants].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.createdAt,
      }));
    },
    async clear() {
      grants.clear();
    },
    withCurrent({ assertCurrent }) {
      const bind =
        <Args extends unknown[], Value>(operation: (...args: Args) => Promise<Value>) =>
        (...args: Args): Promise<Value> => {
          assertCurrent();
          return operation(...args);
        };
      const unused = async (): Promise<never> => {
        throw new Error("Unexpected visitor fixture store operation");
      };
      return Object.freeze({
        register: bind(store.register.bind(store)),
        registerIfAbsent: bind(store.registerIfAbsent.bind(store)),
        lookup: bind(store.lookup.bind(store)),
        consume: bind(store.consume.bind(store)),
        delete: bind(store.delete.bind(store)),
        entries: bind(store.entries.bind(store)),
        clear: bind(store.clear.bind(store)),
        observe: unused,
        compareAndApply: unused,
        deleteIfEqual: unused,
        lookupMany: unused,
        entriesInKeyRange: unused,
        moveEntriesFrom: unused,
        count: unused,
      });
    },
  };
  const cloudflare: {
    policy: PolicyFixture | undefined;
    failWrites: boolean;
    loseWriteResponse: boolean;
    beforeWrite: () => Promise<void>;
    afterWrite: () => void;
  } = {
    policy: options.emails?.length
      ? {
          id: "visitors",
          name: resolved.policyName,
          decision: "allow",
          include: options.emails.map((email) => ({ email: { email } })),
        }
      : undefined,
    failWrites: false,
    loseWriteResponse: false,
    beforeWrite: async () => {},
    afterWrite: () => {},
  };
  const response = (result: unknown) => Response.json({ success: true, result });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url.origin === "https://api.github.com") {
      if (!/^\/users\/[a-z0-9-]+$/.test(url.pathname) || method !== "GET") {
        throw new Error("Unexpected GitHub request");
      }
      return Response.json({ email: options.githubEmail ?? null });
    }
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith(policiesPath)) {
      throw new Error("Unexpected Cloudflare endpoint");
    }
    if (method === "GET") {
      if (url.pathname === policiesPath) {
        return response(cloudflare.policy ? [cloudflare.policy] : []);
      }
      if (url.pathname === `${policiesPath}/visitors` && cloudflare.policy) {
        return response(cloudflare.policy);
      }
      throw new Error("Unknown policy read");
    }
    await cloudflare.beforeWrite();
    if (cloudflare.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (method === "DELETE" && url.pathname === `${policiesPath}/visitors`) {
      cloudflare.policy = undefined;
    } else if (
      (method === "POST" && url.pathname === policiesPath) ||
      (method === "PUT" && url.pathname === `${policiesPath}/visitors`)
    ) {
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
  const runtime: Pick<PluginRuntime, "gateway" | "config"> = {
    gateway: {
      isAvailable: async () => true,
      async request() {
        throw new Error("Expected a mocked Gateway request");
      },
    },
    config: {
      current: () => gatewayConfig,
      async mutateConfigFile() {
        throw new Error("Visitor operations must not change Gateway configuration");
      },
      async replaceConfigFile() {
        throw new Error("Visitor operations must not replace Gateway configuration");
      },
    },
  };
  const gatewayRequest = vi.spyOn(runtime.gateway, "request").mockResolvedValue({
    profiles: options.profiles ?? [],
  });
  const assertCurrent = vi.fn<() => void>();
  const service = new VisitorAccessService(
    resolved,
    store,
    new VisitorPolicyClient(resolved, fetcher),
    logger,
    createVisitorAccessReader(runtime),
    fetcher,
  );
  services.add(service);
  return {
    cloudflare,
    fetcher,
    grants,
    gatewayRequest,
    logger,
    service,
    store,
    authority: { assertCurrent },
    emails: () => cloudflare.policy?.include.map((rule) => rule.email.email) ?? [],
    mutations: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method !== "GET" && init?.method),
  };
}
