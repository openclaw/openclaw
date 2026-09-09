import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import {
  MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE,
  MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE,
  registerMSTeamsEmployeeOpenAIAuthEnrollmentRoutes,
} from "./employee-openai-auth-enrollment-routes.js";
import {
  createMSTeamsEmployeeOpenAIAuthEnrollmentLink,
  type MSTeamsEmployeeOpenAIAuthEnrollmentRecord,
  type MSTeamsEmployeeOpenAIAuthEnrollmentStore,
  type MSTeamsEmployeeOpenAIAuthPendingMapping,
  type MSTeamsEmployeeOpenAIAuthProvider,
} from "./employee-openai-auth-enrollment.js";

const mapping: MSTeamsEmployeeOpenAIAuthPendingMapping = {
  requestId: "request-hash",
  agentId: "kkilgo",
  employeeHash: "employee-hash-kkilgo",
  peerHash: "peer-hash-kkilgo",
  accountId: "default",
  status: "pending",
};

const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access-token",
  refresh: "synthetic-refresh-token",
  expires: Date.parse("2026-09-01T00:00:00.000Z"),
};

function createMemoryStore(options?: {
  failSetAuthOrder?: boolean;
}): MSTeamsEmployeeOpenAIAuthEnrollmentStore & {
  records: MSTeamsEmployeeOpenAIAuthEnrollmentRecord[];
  profiles: Map<string, OAuthCredential>;
  authOrder: Map<string, string>;
} {
  const records = new Map<string, MSTeamsEmployeeOpenAIAuthEnrollmentRecord>();
  const profiles = new Map<string, OAuthCredential>();
  const authOrder = new Map<string, string>();
  const store: MSTeamsEmployeeOpenAIAuthEnrollmentStore & {
    records: MSTeamsEmployeeOpenAIAuthEnrollmentRecord[];
    profiles: Map<string, OAuthCredential>;
    authOrder: Map<string, string>;
  } = {
    records: [],
    profiles,
    authOrder,
    getPendingMapping: async (requestId) => (requestId === mapping.requestId ? mapping : null),
    saveEnrollment: async (record) => {
      records.set(record.id, record);
      store.records = Array.from(records.values());
    },
    getEnrollmentByTokenHash: async (linkTokenHash) =>
      Array.from(records.values()).find((record) => record.linkTokenHash === linkTokenHash) ?? null,
    getEnrollmentByStateHash: async (oauthStateHash) =>
      Array.from(records.values()).find((record) => record.oauthStateHash === oauthStateHash) ??
      null,
    updateEnrollment: async (record) => {
      records.set(record.id, record);
      store.records = Array.from(records.values());
    },
    persistOAuthProfile: async ({ agentId, profileId, credential: storedCredential }) => {
      profiles.set(`${agentId}:${profileId}`, storedCredential);
    },
    setAuthOrder: async ({ agentId, profileId }) => {
      if (options?.failSetAuthOrder) {
        throw new Error("synthetic auth order write failure");
      }
      authOrder.set(agentId, profileId);
    },
    removeOAuthProfile: async ({ agentId, profileId }) => {
      profiles.delete(`${agentId}:${profileId}`);
    },
  };
  return store;
}

function createProvider(): MSTeamsEmployeeOpenAIAuthProvider & {
  states: string[];
} {
  const states: string[] = [];
  return {
    states,
    createAuthorizationUrl: async ({ state }) => {
      states.push(state);
      return "https://auth.openai.example/oauth";
    },
    completeCallback: async () => ({
      profileId: "openai:kkilgo-chatgpt",
      credential,
    }),
  };
}

function createRouteHarness(deps: {
  store: ReturnType<typeof createMemoryStore>;
  provider: ReturnType<typeof createProvider>;
  agentId?: string;
  employeeHash?: string;
  onRegister?: (path: string) => void;
}) {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  registerMSTeamsEmployeeOpenAIAuthEnrollmentRoutes(
    {
      get: (path, handler) => {
        deps.onRegister?.(path);
        routes.set(path, handler);
      },
    },
    {
      store: deps.store,
      provider: deps.provider,
      agentId: deps.agentId ?? "kkilgo",
      employeeHash: deps.employeeHash ?? mapping.employeeHash,
      log,
    },
  );
  return { routes, log };
}

function createResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    redirectStatus: undefined as number | undefined,
    redirectUrl: undefined as string | undefined,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    redirect: vi.fn((statusOrUrl: number | string, url?: string) => {
      response.redirectStatus = typeof statusOrUrl === "number" ? statusOrUrl : 302;
      response.redirectUrl = typeof statusOrUrl === "number" ? url : statusOrUrl;
      return response;
    }),
  };
  return response;
}

async function seedEnrollment(store: ReturnType<typeof createMemoryStore>, token: string) {
  const created = await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
    store,
    requestId: mapping.requestId,
    agentId: mapping.agentId,
    employeeHash: mapping.employeeHash,
    baseUrl: "https://gateway.example",
    tokenFactory: () => token,
    stateFactory: () => "initial-state",
    now: new Date("2026-08-31T20:00:00.000Z"),
    ttlMs: 24 * 60 * 60 * 1000,
  });
  expect(created.status).toBe("created");
}

describe("msteams employee OpenAI auth enrollment gateway routes", () => {
  it("registers start and callback routes", () => {
    const registrationOrder: string[] = [];
    const { routes } = createRouteHarness({
      store: createMemoryStore(),
      provider: createProvider(),
      onRegister: (path) => registrationOrder.push(path),
    });

    expect(routes.has(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)).toBe(true);
    expect(routes.has(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)).toBe(true);
    expect(registrationOrder).toEqual([
      MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE,
      MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE,
    ]);
  });

  it("redirects from opaque link to provider authorization without logging raw token or state", async () => {
    const store = createMemoryStore();
    const provider = createProvider();
    await seedEnrollment(store, "opaque-link-token");
    const { routes, log } = createRouteHarness({ store, provider });
    const response = createResponse();

    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "opaque-link-token" } },
      response,
    );

    expect(response.redirectStatus).toBe(302);
    expect(response.redirectUrl).toBe("https://auth.openai.example/oauth");
    expect(log.info).toHaveBeenCalledWith(
      "msteams employee OpenAI enrollment start",
      expect.objectContaining({ agentId: "kkilgo", valueExposure: false }),
    );
    const logText = JSON.stringify(log.info.mock.calls);
    expect(logText).not.toContain("opaque-link-token");
    expect(logText).not.toContain(provider.states[0]);
  });

  it("completes callback with generic response and redacted logs", async () => {
    const store = createMemoryStore();
    const provider = createProvider();
    await seedEnrollment(store, "opaque-link-token");
    const { routes, log } = createRouteHarness({ store, provider });
    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "opaque-link-token" } },
      createResponse(),
    );
    const response = createResponse();

    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { state: provider.states[0], code: "synthetic-callback-code" } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true, status: "completed", valueExposure: false });
    expect(store.profiles.has("kkilgo:openai:kkilgo-chatgpt")).toBe(true);
    expect(store.authOrder.get("kkilgo")).toBe("openai:kkilgo-chatgpt");
    const logText = JSON.stringify(log.info.mock.calls);
    expect(logText).not.toContain(provider.states[0]);
    expect(logText).not.toContain("synthetic-callback-code");
    expect(logText).not.toContain("synthetic-access-token");
    expect(logText).not.toContain("synthetic-refresh-token");
  });

  it("fails closed for wrong agent, wrong employee, missing state, provider error, and callback mismatch", async () => {
    const store = createMemoryStore();
    const provider = createProvider();
    await seedEnrollment(store, "opaque-link-token");

    const wrongAgent = createRouteHarness({ store, provider, agentId: "main" });
    const wrongAgentResponse = createResponse();
    await wrongAgent.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "opaque-link-token" } },
      wrongAgentResponse,
    );
    expect(wrongAgentResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "wrong-agent",
    });

    const correct = createRouteHarness({ store, provider });
    await correct.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "opaque-link-token" } },
      createResponse(),
    );

    const wrongEmployee = createRouteHarness({
      store,
      provider,
      employeeHash: "different-employee",
    });
    const wrongEmployeeResponse = createResponse();
    await wrongEmployee.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { state: provider.states[0], code: "synthetic-callback-code" } },
      wrongEmployeeResponse,
    );
    expect(wrongEmployeeResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "wrong-employee",
    });

    const missingStateResponse = createResponse();
    await correct.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { code: "synthetic-callback-code" } },
      missingStateResponse,
    );
    expect(missingStateResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "missing-state",
    });

    const mismatchResponse = createResponse();
    await correct.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { state: "wrong-state", code: "synthetic-callback-code" } },
      mismatchResponse,
    );
    expect(mismatchResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "callback-mismatch",
    });

    const providerErrorResponse = createResponse();
    await correct.routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { state: provider.states[0], error: "access_denied" } },
      providerErrorResponse,
    );
    expect(providerErrorResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "provider-error",
    });
  });

  it("fails closed for expired and replayed links", async () => {
    const store = createMemoryStore();
    const provider = createProvider();
    await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
      store,
      requestId: mapping.requestId,
      agentId: mapping.agentId,
      employeeHash: mapping.employeeHash,
      baseUrl: "https://gateway.example",
      tokenFactory: () => "expired-link-token",
      ttlMs: 1,
      now: new Date("2026-08-31T20:00:00.000Z"),
    });
    const { routes } = createRouteHarness({ store, provider });
    const expiredResponse = createResponse();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T20:00:01.000Z"));
      await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
        { params: { token: "expired-link-token" } },
        expiredResponse,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(expiredResponse.body).toMatchObject({
      status: "blocked",
      failureCode: "expired-link",
    });

    await seedEnrollment(store, "replay-link-token");
    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "replay-link-token" } },
      createResponse(),
    );
    const replayResponse = createResponse();
    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "replay-link-token" } },
      replayResponse,
    );
    expect(replayResponse.body).toMatchObject({ status: "blocked", failureCode: "reused-link" });
  });

  it("rolls back partial profile bind when auth order write fails", async () => {
    const store = createMemoryStore({ failSetAuthOrder: true });
    const provider = createProvider();
    await seedEnrollment(store, "opaque-link-token");
    const { routes } = createRouteHarness({ store, provider });
    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_START_ROUTE)!(
      { params: { token: "opaque-link-token" } },
      createResponse(),
    );
    const response = createResponse();

    await routes.get(MSTEAMS_OPENAI_AUTH_ENROLLMENT_CALLBACK_ROUTE)!(
      { query: { state: provider.states[0], code: "synthetic-callback-code" } },
      response,
    );

    expect(response.body).toMatchObject({
      status: "blocked",
      failureCode: "partial-bind-rolled-back",
    });
    expect(store.profiles.has("kkilgo:openai:kkilgo-chatgpt")).toBe(false);
    expect(store.authOrder.has("kkilgo")).toBe(false);
  });
});
