import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
// Msteams tests cover employee-safe OpenAI auth enrollment links.
import { describe, expect, it, vi } from "vitest";
import {
  createMSTeamsEmployeeOpenAIAuthEnrollmentLink,
  completeMSTeamsEmployeeOpenAIAuthEnrollment,
  startMSTeamsEmployeeOpenAIAuthEnrollment,
  type MSTeamsEmployeeOpenAIAuthEnrollmentRecord,
  type MSTeamsEmployeeOpenAIAuthEnrollmentStore,
  type MSTeamsEmployeeOpenAIAuthPendingMapping,
  type MSTeamsEmployeeOpenAIAuthProvider,
} from "./employee-openai-auth-enrollment.js";

const mapping: MSTeamsEmployeeOpenAIAuthPendingMapping = {
  requestId: "msteams-employee-onboarding-request-hash",
  agentId: "kkilgo",
  employeeHash: "employee-hash-kkilgo",
  peerHash: "peer-hash-kkilgo",
  accountId: "default",
  status: "pending",
};

const oauthCredential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access-value",
  refresh: "synthetic-refresh-value",
  expires: Date.parse("2026-09-01T00:00:00.000Z"),
};

function createMemoryEnrollmentStore(options?: {
  pending?: MSTeamsEmployeeOpenAIAuthPendingMapping | null;
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
    records: Array.from(records.values()),
    profiles,
    authOrder,
    getPendingMapping: async (requestId) =>
      options?.pending === null
        ? null
        : requestId === (options?.pending ?? mapping).requestId
          ? (options?.pending ?? mapping)
          : null,
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
    persistOAuthProfile: async ({ agentId, profileId, credential }) => {
      profiles.set(`${agentId}:${profileId}`, credential);
    },
    setAuthOrder: async ({ agentId, profileId }) => {
      if (options?.failSetAuthOrder) {
        throw new Error("synthetic auth order write failed");
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
  completeCallbackMock: ReturnType<typeof vi.fn>;
} {
  const states: string[] = [];
  const completeCallbackMock = vi.fn(async () => ({
    profileId: "openai:kkilgo-chatgpt",
    credential: oauthCredential,
  }));
  return {
    states,
    completeCallbackMock,
    createAuthorizationUrl: async ({ state }) => {
      states.push(state);
      return `https://auth.openai.com/oauth/authorize?client_id=openclaw&state=${encodeURIComponent(
        state,
      )}`;
    },
    completeCallback: completeCallbackMock,
  };
}

async function createStartedEnrollment(params?: {
  store?: ReturnType<typeof createMemoryEnrollmentStore>;
  provider?: ReturnType<typeof createProvider>;
  now?: Date;
}) {
  const store = params?.store ?? createMemoryEnrollmentStore();
  const provider = params?.provider ?? createProvider();
  const created = await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
    store,
    requestId: mapping.requestId,
    agentId: mapping.agentId,
    employeeHash: mapping.employeeHash,
    baseUrl: "https://gateway.example",
    tokenFactory: () => "opaque-enrollment-link-token",
    stateFactory: () => "initial-state-not-exposed",
    now: params?.now ?? new Date("2026-08-31T20:00:00.000Z"),
  });
  expect(created.status).toBe("created");
  if (created.status !== "created") {
    throw new Error("expected created enrollment");
  }
  const start = await startMSTeamsEmployeeOpenAIAuthEnrollment({
    store,
    provider,
    linkToken: "opaque-enrollment-link-token",
    agentId: mapping.agentId,
    employeeHash: mapping.employeeHash,
    now: new Date("2026-08-31T20:01:00.000Z"),
  });
  expect(start.status).toBe("redirect");
  return { store, provider, created, start };
}

describe("msteams employee OpenAI auth enrollment link", () => {
  it("creates a one-time opaque Teams-safe link and redacted proof", async () => {
    const store = createMemoryEnrollmentStore();

    const result = await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
      store,
      requestId: mapping.requestId,
      agentId: "kkilgo",
      employeeHash: mapping.employeeHash,
      baseUrl: "https://gateway.example",
      tokenFactory: () => "opaque-enrollment-link-token",
      stateFactory: () => "opaque-oauth-state",
      now: new Date("2026-08-31T20:00:00.000Z"),
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      return;
    }
    expect(result.enrollmentLink).toBe(
      "https://gateway.example/auth/enroll/openai/opaque-enrollment-link-token",
    );
    expect(result.message).toContain("Do not paste passwords, API keys, codes, or tokens");
    expect(JSON.stringify(result.proof)).not.toContain("opaque-enrollment-link-token");
    expect(JSON.stringify(result.proof)).not.toContain("opaque-oauth-state");
    expect(result.proof).toMatchObject({
      agentId: "kkilgo",
      employeeHash: mapping.employeeHash,
      provider: "openai",
      method: "chatgpt-login",
      status: "pending",
      valueExposure: false,
    });
  });

  it("redirects to provider-owned OpenAI OAuth and completes kkilgo binding with redacted status", async () => {
    const { store, provider } = await createStartedEnrollment();

    const completed = await completeMSTeamsEmployeeOpenAIAuthEnrollment({
      store,
      provider,
      state: provider.states[0],
      callbackCode: "synthetic-callback-code",
      agentId: "kkilgo",
      employeeHash: mapping.employeeHash,
      now: new Date("2026-08-31T20:02:00.000Z"),
    });

    expect(completed.status).toBe("completed");
    expect(store.authOrder.get("kkilgo")).toBe("openai:kkilgo-chatgpt");
    expect(store.profiles.has("kkilgo:openai:kkilgo-chatgpt")).toBe(true);
    expect(JSON.stringify(completed.proof)).not.toContain("synthetic-callback-code");
    expect(JSON.stringify(completed.proof)).not.toContain("synthetic-access-value");
    expect(completed.proof).toMatchObject({
      agentId: "kkilgo",
      profilePresent: true,
      authOrderPresent: true,
      valueExposure: false,
    });
  });

  it("fails closed for wrong employee and wrong agent without provider redirect", async () => {
    const { store, provider } = await createStartedEnrollment();

    await expect(
      startMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        linkToken: "opaque-enrollment-link-token",
        agentId: "main",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "wrong-agent", valueExposure: false },
    });
    await expect(
      completeMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        state: provider.states[0],
        callbackCode: "synthetic-callback-code",
        agentId: "kkilgo",
        employeeHash: "different-employee",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "wrong-employee", valueExposure: false },
    });
  });

  it("fails closed for replay and expired links", async () => {
    const store = createMemoryEnrollmentStore();
    const provider = createProvider();
    await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
      store,
      requestId: mapping.requestId,
      agentId: "kkilgo",
      employeeHash: mapping.employeeHash,
      baseUrl: "https://gateway.example",
      tokenFactory: () => "expired-token",
      now: new Date("2026-08-31T20:00:00.000Z"),
      ttlMs: 1,
    });

    await expect(
      startMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        linkToken: "expired-token",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
        now: new Date("2026-08-31T20:00:01.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { status: "failed", failureCode: "expired-link", valueExposure: false },
    });

    const started = await createStartedEnrollment({
      store: createMemoryEnrollmentStore(),
      provider,
    });
    await expect(
      startMSTeamsEmployeeOpenAIAuthEnrollment({
        store: started.store,
        provider,
        linkToken: "opaque-enrollment-link-token",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "reused-link", valueExposure: false },
    });
  });

  it("fails closed on provider callback errors and callback state mismatch", async () => {
    const { store, provider } = await createStartedEnrollment();

    await expect(
      completeMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        state: "wrong-state",
        callbackCode: "synthetic-callback-code",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "callback-mismatch", valueExposure: false },
    });
    await expect(
      completeMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        state: provider.states[0],
        providerError: "access_denied",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { status: "failed", failureCode: "provider-error", valueExposure: false },
    });
  });

  it("fails closed when provider authorization URL creation fails", async () => {
    const store = createMemoryEnrollmentStore();
    const provider = {
      ...createProvider(),
      createAuthorizationUrl: vi.fn(async () => {
        throw new Error("synthetic provider authorization failure");
      }),
    };
    const created = await createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
      store,
      requestId: mapping.requestId,
      agentId: "kkilgo",
      employeeHash: mapping.employeeHash,
      baseUrl: "https://gateway.example",
      tokenFactory: () => "provider-start-failure-token",
    });
    expect(created.status).toBe("created");

    await expect(
      startMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        linkToken: "provider-start-failure-token",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { status: "failed", failureCode: "provider-error", valueExposure: false },
    });
  });

  it("rolls back a partial bind when auth order persistence fails", async () => {
    const store = createMemoryEnrollmentStore({ failSetAuthOrder: true });
    const provider = createProvider();
    await createStartedEnrollment({ store, provider });

    await expect(
      completeMSTeamsEmployeeOpenAIAuthEnrollment({
        store,
        provider,
        state: provider.states[0],
        callbackCode: "synthetic-callback-code",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: {
        status: "failed",
        failureCode: "partial-bind-rolled-back",
        authOrderPresent: false,
        valueExposure: false,
      },
    });
    expect(store.profiles.has("kkilgo:openai:kkilgo-chatgpt")).toBe(false);
    expect(store.authOrder.has("kkilgo")).toBe(false);
  });

  it("blocks missing pending requests and missing callback state with redacted proof", async () => {
    const store = createMemoryEnrollmentStore({ pending: null });
    await expect(
      createMSTeamsEmployeeOpenAIAuthEnrollmentLink({
        store,
        requestId: mapping.requestId,
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
        baseUrl: "https://gateway.example",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "missing-pending-request", valueExposure: false },
    });

    await expect(
      completeMSTeamsEmployeeOpenAIAuthEnrollment({
        store: createMemoryEnrollmentStore(),
        provider: createProvider(),
        state: undefined,
        callbackCode: "synthetic-callback-code",
        agentId: "kkilgo",
        employeeHash: mapping.employeeHash,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      proof: { failureCode: "missing-state", valueExposure: false },
    });
  });
});
