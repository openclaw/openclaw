import type { LlmRuntime } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CodexApiError } from "../../../packages/ai/src/providers/openai-chatgpt-responses-events.js";
import { projectProviderError } from "../../../packages/ai/src/utils/provider-error.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
// Renewable Sign-in-with-ChatGPT (chatgpt-token-sharing) request credentials:
// per-request owner re-resolution leads the captured key, and a structured
// 401 token_expired terminal that arrives before any output is accepted gets
// exactly one forced same-profile reacquisition and request retry. Static,
// token, and provider-exchange contracts are unchanged.
//
// The stream tests drive real `AssistantMessageEventStream` objects whose
// terminal error events carry the production projection
// (`projectProviderError` output), and the resolver tests run the canonical
// `getApiKeyForModelCore` owner against real profile stores — no production
// code path is mocked.
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { snapshotReaderSlot } from "../../plugins/plugin-metadata-snapshot-readers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { createOAuthRefreshCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type { AuthProfileCredential, OAuthCredential } from "../auth-profiles/types.js";
import { resolveProviderEnvAuthLookupMaps } from "../model-auth-env-vars.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  createRenewableRequestApiKeyResolver,
  isTokenExpiredUnauthorizedTerminal,
} from "./run/auth-store.js";
import { selectEmbeddedAgentStream } from "./stream-resolution.js";

// mock-isolation: fixed env-credential lookup tables; the canonical owner
// runs unmocked and no machine-local env credential may leak into it.
vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
    setupProviderFallbackRefs: [],
  }),
}));

const cliCredentialMocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<(options?: unknown) => AuthProfileCredential | null>(
    () => null,
  ),
}));
// mock-isolation: no host CLI credentials may satisfy the canonical owner.
vi.mock("../cli-credentials.js", () => cliCredentialMocks);

// mock-isolation: no host plugin-provided auth profiles may satisfy the owner.
vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

let previousEnvNameReader: typeof snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore;
beforeEach(() => {
  previousEnvNameReader = snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore;
  const { envCandidateMap } = resolveProviderEnvAuthLookupMaps();
  snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore = () => [
    ...new Set(Object.values(envCandidateMap).flat()),
  ];
  setRuntimeConfigSnapshot({});
  cliCredentialMocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
  cliCredentialMocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
});

afterEach(() => {
  snapshotReaderSlot.listKnownProviderAuthEnvVarNamesCore = previousEnvNameReader;
  clearRuntimeConfigSnapshot();
});

// Canonical-owner tests run inside a fresh, uncontended state dir (the repo
// standard auth-state fixture) so state-worker leases never contend with
// machine-local state.
const authStateOptions = {
  layout: "state-only",
  prefix: "openclaw-auth-",
  agentEnv: "main",
} as const;
async function withAuthOwner<T>(run: (state: OpenClawTestState) => Promise<T>): Promise<T> {
  return withOpenClawTestState(authStateOptions, async (state) => {
    prepareSharedAuthStoreOwnershipForNative();
    clearRuntimeAuthProfileStoreSnapshots();
    // The fixture env apply resets config runtime state; re-seed it inside the
    // fixture so the canonical owner resolves against an empty config.
    setRuntimeConfigSnapshot({});
    try {
      return await run(state);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      clearRuntimeConfigSnapshot();
    }
  });
}

const llmRuntime = { ...defaultLlmRuntime } as LlmRuntime;
const model = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5-2025-08-07",
} as unknown as Model;
const context = { messages: [] } as never;

type InnerSpy = Mock & StreamFn;
const fakeInner = (impl?: () => unknown): InnerSpy => {
  const spy = vi.fn() as unknown as InnerSpy;
  if (impl) {
    spy.mockImplementation(impl as never);
  }
  return spy;
};
const innerApiKey = (inner: InnerSpy, call: number): string | undefined =>
  (inner.mock.calls[call] as unknown as [unknown, unknown, { apiKey?: string }])[2]?.apiKey;

function resolveWrapped(params: {
  resolvedApiKey?: string;
  resolveRenewableApiKey?: (options?: { forceRefresh?: boolean }) => Promise<string | undefined>;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
  assertCurrent?: () => void;
}): (inner: StreamFn) => StreamFn {
  const { wrapApiKey } = selectEmbeddedAgentStream({
    llmRuntime,
    currentStreamFn: undefined,
    sessionId: "session-1",
    model,
    providerStreamFn: vi.fn() as unknown as StreamFn,
    ...params,
  });
  return wrapApiKey;
}

// ---------------------------------------------------------------------------
// Production terminal shapes
// ---------------------------------------------------------------------------

const tokenExpiredTransportError = () =>
  new CodexApiError("The authentication token is expired", {
    status: 401,
    payload: {
      error: {
        code: "token_expired",
        type: "invalid_request_error",
        message: "The authentication token is expired.",
      },
    },
  });

const revokedGrantTransportError = () =>
  new CodexApiError("This access token was revoked", {
    status: 401,
    payload: {
      error: {
        code: "invalid_grant",
        type: "invalid_request_error",
        message: "This access token was revoked.",
      },
    },
  });

/**
 * The exact throw shape the real OpenAI Responses transport client surfaces
 * for a wire 401: the SDK `APIError` message already embeds the status
 * without the local projection's colon ("401 The authentication token is
 * expired"), and its `code`/`error` fields carry the provider code.
 */
const responsesSdk401Error = () =>
  Object.assign(new Error("401 The authentication token is expired"), {
    status: 401,
    code: "token_expired",
    message: "401 The authentication token is expired",
    error: {
      code: "token_expired",
      type: "invalid_request_error",
      message: "The authentication token is expired",
    },
  });

/** A terminal transport stream exactly as `failTransportStream` produces one. */
const terminalProviderStream = (error: unknown) => {
  const stream = createAssistantMessageEventStream();
  const output = makeAssistantMessageFixture({});
  Object.assign(output, projectProviderError(error));
  const terminalOutput = output as typeof output & { stopReason: "aborted" | "error" };
  stream.push({ type: "start", partial: output });
  stream.push({ type: "error", reason: terminalOutput.stopReason, error: terminalOutput });
  stream.end();
  return stream;
};

/** A successful transport stream: start, one delta, done. */
const successStream = () => {
  const stream = createAssistantMessageEventStream();
  const base = makeAssistantMessageFixture({ stopReason: "stop" });
  stream.push({ type: "start", partial: base });
  stream.push({ type: "text_start", contentIndex: 0, partial: base });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "ok" });
  const done = {
    ...base,
    stopReason: "stop" as const,
    content: [{ type: "text", text: "ok" }],
  } as typeof base;
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: "ok",
    partial: done,
  });
  stream.push({ type: "done", reason: "stop", message: done });
  stream.end(done);
  return { stream, done };
};

/** A stream that emitted output and then failed with the given transport error. */
const failedAfterOutputStream = (error: unknown) => {
  const stream = createAssistantMessageEventStream();
  const base = makeAssistantMessageFixture({ stopReason: "stop" });
  stream.push({ type: "start", partial: base });
  stream.push({ type: "text_start", contentIndex: 0, partial: base });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "partial" });
  const failed = makeAssistantMessageFixture({});
  Object.assign(failed, projectProviderError(error));
  const failedTerminal = failed as typeof failed & { stopReason: "aborted" | "error" };
  stream.push({ type: "error", reason: failedTerminal.stopReason, error: failedTerminal });
  stream.end();
  return stream;
};

const collect = async (stream: AsyncIterable<AssistantMessageEvent>) => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

// ---------------------------------------------------------------------------
// Stream wrapper: per-request renewal + one bounded retry
// ---------------------------------------------------------------------------

describe("wrapEmbeddedAgentStreamApiKey renewable credentials", () => {
  it("lets the selected profile's current access lead the captured key and static override", async () => {
    const inner = fakeInner(() => successStream().stream);
    const wrapped = resolveWrapped({
      resolvedApiKey: "captured-A",
      authStorage: { getApiKey: vi.fn(() => Promise.resolve("stored-A")) },
      resolveRenewableApiKey: vi.fn(() => Promise.resolve("siwc-B")),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(innerApiKey(inner, 0)).toBe("siwc-B");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("falls back to the captured key when the owner cannot produce a key", async () => {
    const inner = fakeInner(() => successStream().stream);
    const wrapped = resolveWrapped({
      resolvedApiKey: "captured-A",
      resolveRenewableApiKey: vi.fn(() => Promise.resolve(undefined)),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(innerApiKey(inner, 0)).toBe("captured-A");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("keeps the captured-key-first contract for static credentials", async () => {
    const inner = fakeInner(() => successStream().stream);
    const wrapped = resolveWrapped({
      resolvedApiKey: "static-K",
      authStorage: { getApiKey: vi.fn(() => Promise.resolve("stored-A")) },
    })(inner);

    await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(innerApiKey(inner, 0)).toBe("static-K");
  });

  it("uses the storage key when no captured key exists and the profile is not renewable", async () => {
    const inner = fakeInner(() => successStream().stream);
    const wrapped = resolveWrapped({
      authStorage: { getApiKey: vi.fn(() => Promise.resolve("stored-A")) },
    })(inner);

    await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(innerApiKey(inner, 0)).toBe("stored-A");
  });

  it("recovers a pre-output 401 token_expired via one forced reacquisition and one retry", async () => {
    const inner = fakeInner();
    inner
      .mockImplementationOnce(() => terminalProviderStream(tokenExpiredTransportError()))
      .mockImplementationOnce(() => successStream().stream);
    const refresh = vi
      .fn<(options?: { forceRefresh?: boolean }) => Promise<string | undefined>>()
      .mockResolvedValue("siwc-access-B");
    const wrapped = resolveWrapped({
      resolvedApiKey: "captured-A",
      resolveRenewableApiKey: vi
        .fn()
        .mockResolvedValueOnce("siwc-access-A")
        .mockImplementation(refresh),
    })(inner);

    const stream = await wrapped(model, context, {});
    const events = await collect(stream);
    expect(inner).toHaveBeenCalledTimes(2);
    expect([innerApiKey(inner, 0), innerApiKey(inner, 1)]).toEqual([
      "siwc-access-A",
      "siwc-access-B",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ forceRefresh: true });
    // The rejected request's start and error are never surfaced; the consumer
    // sees exactly one clean turn from the retried request.
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const result = await stream.result();
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("does not retry when the forced reacquisition returns the same key", async () => {
    const inner = fakeInner(() => terminalProviderStream(tokenExpiredTransportError()));
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi.fn(() => Promise.resolve("siwc-access-A")),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry when the forced reacquisition cannot produce a key", async () => {
    const inner = fakeInner(() => terminalProviderStream(tokenExpiredTransportError()));
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi.fn(() => Promise.resolve(undefined)),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry unauthorized rejections that are not token expiry", async () => {
    const inner = fakeInner(() => terminalProviderStream(revokedGrantTransportError()));
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi.fn(() => Promise.resolve("siwc-access-A")),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry a 403 that only mentions expiry in prose", async () => {
    const inner = fakeInner(() =>
      terminalProviderStream(
        Object.assign(new Error("403 Forbidden"), {
          status: 403,
          message: "403: The authentication token is expired.",
        }),
      ),
    );
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi.fn(() => Promise.resolve("siwc-access-A")),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry a 401 that arrives after output was already forwarded", async () => {
    const inner = fakeInner(() => failedAfterOutputStream(tokenExpiredTransportError()));
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi.fn(() => Promise.resolve("siwc-access-A")),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "error",
    ]);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
  });

  it("surfaces a second expiry without looping", async () => {
    const inner = fakeInner(() => terminalProviderStream(tokenExpiredTransportError()));
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi
        .fn()
        .mockResolvedValueOnce("siwc-access-A")
        .mockResolvedValueOnce("siwc-access-B")
        .mockResolvedValue("siwc-access-B"),
    })(inner);

    const events = await collect(await wrapped(model, context, {}));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("revalidates run authority before the retried request", async () => {
    const inner = fakeInner(() => terminalProviderStream(tokenExpiredTransportError()));
    let current = true;
    const wrapped = resolveWrapped({
      resolveRenewableApiKey: vi
        .fn()
        .mockResolvedValueOnce("siwc-access-A")
        .mockResolvedValueOnce("siwc-access-B"),
      assertCurrent: () => {
        if (!current) {
          throw new Error("source authority revoked");
        }
      },
    })(inner);

    const pending = wrapped(model, context, {});
    const stream = await pending;
    current = false;
    await expect(collect(stream)).rejects.toThrow("source authority revoked");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("keeps non-renewable streams on the zero-copy pass-through path", async () => {
    const inner = fakeInner(() => successStream().stream);
    const wrapped = resolveWrapped({ resolvedApiKey: "captured-A" })(inner);
    const events = await collect(await wrapped(model, context, {}));
    expect(events.at(-1)?.type).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Structured terminal classifier (production projection shapes)
// ---------------------------------------------------------------------------

describe("isTokenExpiredUnauthorizedTerminal", () => {
  const terminalFor = (error: unknown, overrides: Partial<AssistantMessage> = {}) => {
    const projected = {
      ...projectProviderError(error),
      ...overrides,
    };
    return { ...projected, stopReason: "error" } as Parameters<
      typeof isTokenExpiredUnauthorizedTerminal
    >[0];
  };

  it("accepts the Responses transport 401 token_expired rejection", () => {
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(tokenExpiredTransportError()))).toBe(
      true,
    );
  });

  it("accepts a 401 whose redacted body carries the expiry code", () => {
    const error = Object.assign(new Error("401 Unauthorized"), {
      status: 401,
      body: JSON.stringify({ error: { code: "token_expired", message: "expired" } }),
    });
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(error))).toBe(true);
  });

  it("accepts an explicit expiry marker in the 401 projection text", () => {
    const error = Object.assign(new Error("401: authentication token is expired"), {
      status: 401,
    });
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(error))).toBe(true);
  });

  it("rejects a 403 that only mentions expiry in prose", () => {
    const error = Object.assign(new Error("403: The authentication token is expired."), {
      status: 403,
    });
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(error))).toBe(false);
  });

  it("accepts the real Responses SDK 401 projection (status-embedded message, provider code)", () => {
    const projection = projectProviderError(responsesSdk401Error());
    // The production fact: the SDK message keeps the status without the
    // projection's colon, and the provider code shadows the HTTP status.
    expect(projection.errorMessage).toBe("401 The authentication token is expired");
    expect(projection.errorCode).toBe("token_expired");
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(responsesSdk401Error()))).toBe(true);
  });

  it("rejects a 401 without an expiry fact (revoked grant, invalid key)", () => {
    expect(isTokenExpiredUnauthorizedTerminal(terminalFor(revokedGrantTransportError()))).toBe(
      false,
    );
    expect(
      isTokenExpiredUnauthorizedTerminal(
        terminalFor(Object.assign(new Error("401: invalid api key"), { status: 401 })),
      ),
    ).toBe(false);
  });

  it("rejects non-401 statuses and non-error terminals", () => {
    expect(
      isTokenExpiredUnauthorizedTerminal(
        terminalFor(Object.assign(new Error("500 internal server error"), { status: 500 })),
      ),
    ).toBe(false);
    expect(
      isTokenExpiredUnauthorizedTerminal({
        stopReason: "aborted",
        errorCode: "401",
        errorMessage: "401: token_expired",
      }),
    ).toBe(false);
    expect(isTokenExpiredUnauthorizedTerminal(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolver factory: canonical owner boundary (no production seams mocked)
// ---------------------------------------------------------------------------

describe("createRenewableRequestApiKeyResolver", () => {
  const siwcApiKeyInfo = {
    apiKey: "captured-A",
    profileId: "openai:seat-a",
    source: "profile:openai:seat-a",
    mode: "oauth" as const,
    authFlow: "chatgpt-token-sharing",
  };
  type TestApiKeyInfo = {
    apiKey?: string;
    profileId?: string;
    source: string;
    mode: "api-key" | "oauth" | "token" | "aws-sdk";
    authFlow?: string;
  } | null;
  type PublishSpy = Mock & ((provider: string, apiKey: string) => void);

  const siwcStore = (access: string, overrides: Record<string, unknown> = {}): AuthProfileStore =>
    ({
      version: 1,
      profiles: {
        "openai:seat-a": createOAuthRefreshCredential({
          access,
          expires: Date.now() + 60 * 60 * 1000,
          authFlow: "chatgpt-token-sharing",
          ...overrides,
        }),
      },
    }) as unknown as AuthProfileStore;

  const makeResolver = (overrides: {
    apiKeyInfo?: TestApiKeyInfo;
    runtimeAuthState?: { apiKey: string; sourceApiKey: string; authMode: string } | null;
    store?: AuthProfileStore;
    agentDir?: string;
  }) => {
    const publishApiKey: PublishSpy = vi.fn() as unknown as PublishSpy;
    const resolver = createRenewableRequestApiKeyResolver({
      getAuthState: () => ({
        apiKeyInfo: overrides.apiKeyInfo ?? siwcApiKeyInfo,
        runtimeAuthState: overrides.runtimeAuthState ?? null,
      }),
      getModel: () => model,
      agentDir: overrides.agentDir ?? "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      resolveAuthStore: () => overrides.store ?? ({ version: 1, profiles: {} } as AuthProfileStore),
      publishApiKey,
    });
    return { resolver, publishApiKey };
  };

  it.each([
    [
      "static api-key profiles",
      { ...siwcApiKeyInfo, mode: "api-key" as const, authFlow: undefined },
    ],
    ["token profiles", { ...siwcApiKeyInfo, mode: "token" as const, authFlow: undefined }],
    ["non-SIWC oauth profiles", { ...siwcApiKeyInfo, authFlow: "codex" }],
    ["profiles without an id", { ...siwcApiKeyInfo, profileId: undefined }],
  ])("keeps the captured contract for %s", async (_name, apiKeyInfo) => {
    // A valid SIWC credential sits in the store: the resolver must still stay
    // out for non-SIWC runtime state because the gate short-circuits first.
    const { resolver, publishApiKey } = makeResolver({
      apiKeyInfo,
      store: siwcStore("siwc-store-access"),
    });
    await expect(resolver()).resolves.toBeUndefined();
    expect(publishApiKey).not.toHaveBeenCalled();
  });

  it("keeps the captured contract when provider exchange owns the credential", async () => {
    const { resolver, publishApiKey } = makeResolver({
      runtimeAuthState: { apiKey: "exchange-B", sourceApiKey: "captured-A", authMode: "oauth" },
      store: siwcStore("siwc-store-access"),
    });
    await expect(resolver()).resolves.toBeUndefined();
    expect(publishApiKey).not.toHaveBeenCalled();
  });

  it("resolves the selected seat's current access through the canonical owner", async () => {
    await withAuthOwner(async (state) => {
      await state.writeAuthProfiles(siwcStore("siwc-current"));
      const agentDir = state.agentDir();
      const { resolver, publishApiKey } = makeResolver({
        store: ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
        agentDir,
      });

      await expect(resolver()).resolves.toBe("siwc-current");
      expect(publishApiKey).toHaveBeenCalledWith("openai", "siwc-current");
    });
  });

  it("tracks runtime state rotation between calls", async () => {
    await withAuthOwner(async (state) => {
      await state.writeAuthProfiles(siwcStore("siwc-current"));
      const agentDir = state.agentDir();
      let apiKeyInfo: TestApiKeyInfo = siwcApiKeyInfo;
      const publishApiKey: PublishSpy = vi.fn() as unknown as PublishSpy;
      const resolver = createRenewableRequestApiKeyResolver({
        getAuthState: () => ({ apiKeyInfo, runtimeAuthState: null }),
        getModel: () => model,
        agentDir,
        workspaceDir: "/tmp/workspace",
        resolveAuthStore: () => ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
        publishApiKey,
      });

      await expect(resolver()).resolves.toBe("siwc-current");
      // The attempt's selected credential flips to a static contract mid-run.
      apiKeyInfo = { ...siwcApiKeyInfo, mode: "api-key" as const, authFlow: undefined };
      await expect(resolver()).resolves.toBeUndefined();
      expect(publishApiKey).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the captured credential when the selected seat is missing", async () => {
    await withAuthOwner(async (state) => {
      await state.writeAuthProfiles({ version: 1, profiles: {} } as AuthProfileStore);
      const agentDir = state.agentDir();
      const { resolver, publishApiKey } = makeResolver({
        store: ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
        agentDir,
      });
      await expect(resolver()).resolves.toBeUndefined();
      expect(publishApiKey).not.toHaveBeenCalled();
    });
  });

  it("keeps the captured credential when the owner cannot renew an expired seat", async () => {
    await withAuthOwner(async (state) => {
      // No refresh token: the seat is expired and cannot be renewed without
      // network, so the owner must fail fast and the captured key is kept.
      await state.writeAuthProfiles(
        siwcStore("siwc-expired", { expires: Date.now() - 60_000, refresh: undefined }),
      );
      const agentDir = state.agentDir();
      const { resolver, publishApiKey } = makeResolver({
        store: ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
        agentDir,
      });
      await expect(resolver({ forceRefresh: true })).resolves.toBeUndefined();
      expect(publishApiKey).not.toHaveBeenCalled();
    });
  });
});
