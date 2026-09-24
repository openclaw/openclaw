// Hard wait backstop for embedded-run auth steps: credential resolution and runtime auth exchange.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { drainFileLockStateForTest } from "../../../infra/file-lock.js";
import { resolveSecretSentinel } from "../../../secrets/sentinel.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
} from "../../auth-profiles/constants.js";
import { createOAuthManager } from "../../auth-profiles/oauth-manager.js";
import { isPendingOAuthRefreshFence } from "../../auth-profiles/oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "../../auth-profiles/persisted.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../../auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../../auth-profiles/types.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import {
  RUNTIME_AUTH_HARD_TIMEOUT_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
} from "./helpers.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  );
  return { ...actual, prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth };
});

vi.mock("../../model-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js");
  return { ...actual, getApiKeyForModelCore: mocks.getApiKeyForModelCore };
});

import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";

function createTestModel(): Model {
  return {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  };
}

function createHarness(): EmbeddedRunAuthState {
  return {
    models: { runtime: createTestModel(), effective: createTestModel() },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "medium",
  };
}

function createController(params: {
  harness: EmbeddedRunAuthState;
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
  profileCandidates?: string[];
  agentDir?: string;
  warn?: (message: string) => void;
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore: { version: 1, profiles: {} },
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    authProfileStateMode: "read-only",
    provider: "custom-openai",
    modelId: "test-model",
    state: params.harness,
    log: { debug: () => undefined, info: () => undefined, warn: params.warn ?? (() => undefined) },
  });
}

// Observe a promise that may never settle without awaiting it.
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error: unknown) => Object.assign(outcome, { settled: true, error }),
  );
  return outcome;
}

function sourceAuth(profileId: string): ResolvedProviderAuth {
  return { apiKey: `${profileId}-source-key`, mode: "api-key", profileId, source: "env" };
}

function lastRuntimeKey(setRuntimeApiKey: ReturnType<typeof vi.fn>): string | undefined {
  const value = setRuntimeApiKey.mock.calls.at(-1)?.[1];
  return typeof value === "string" ? resolveSecretSentinel(value) : undefined;
}

describe("embedded run auth hard deadline", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModelCore.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the hard deadline above two OAuth manager attempts", () => {
    // Each attempt may sleep through every lock retry, then observe the refresh owner.
    const lockRetryCeilingMs =
      OAUTH_REFRESH_LOCK_OPTIONS.retries.retries * OAUTH_REFRESH_LOCK_OPTIONS.retries.maxTimeout;
    const attemptCeilingMs = lockRetryCeilingMs + OAUTH_REFRESH_CALL_TIMEOUT_MS;
    expect(RUNTIME_AUTH_HARD_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * attemptCeilingMs + 60_000);
  });

  it("fails cold-start auth with the deadline error when the runtime auth exchange never settles", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const setRuntimeApiKey = vi.fn();
    mocks.getApiKeyForModelCore.mockResolvedValue(sourceAuth("default"));
    mocks.prepareProviderRuntimeAuth.mockReturnValue(new Promise(() => {}));
    const controller = createController({ harness, setRuntimeApiKey });

    const init = track(controller.initializeAuthProfile());
    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_HARD_TIMEOUT_MS - 1);
    expect(init.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(init.settled).toBe(true);
    expect(init.error).toBeInstanceOf(Error);
    expect(init.error).toMatchObject({
      message: `Runtime auth exchange for custom-openai timed out after ${RUNTIME_AUTH_HARD_TIMEOUT_MS}ms`,
    });
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
    expect(harness.runtimeAuthState).toBeNull();
  });

  it("releases refresh waiters at the deadline and drops the late refresh result", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const setRuntimeApiKey = vi.fn();
    const warn = vi.fn();
    const lateRefresh = createDeferred<{ apiKey: string; expiresAt: number }>();
    const retryExpiresAt = Date.now() + 60 * 60_000;
    mocks.getApiKeyForModelCore.mockResolvedValue(sourceAuth("default"));
    mocks.prepareProviderRuntimeAuth
      .mockResolvedValueOnce({ apiKey: "initial-runtime-key", expiresAt: Date.now() + 60_000 })
      .mockReturnValueOnce(lateRefresh.promise)
      .mockResolvedValueOnce({ apiKey: "retry-runtime-key", expiresAt: retryExpiresAt });
    const controller = createController({ harness, setRuntimeApiKey, warn });

    await controller.initializeAuthProfile();
    // The first credential is inside the refresh margin, so the refresh fires at the minimum delay.
    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_MIN_DELAY_MS);
    expect(harness.runtimeAuthState?.refreshInFlight).toBeDefined();
    // A turn that hits an auth error joins the same single-flight refresh.
    const authErrorRefresh = track(
      controller.maybeRefreshRuntimeAuthForAuthError("HTTP 401: invalid_api_key", false),
    );

    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_HARD_TIMEOUT_MS - 1);
    expect(authErrorRefresh.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(authErrorRefresh).toEqual({ settled: true, value: false });
    expect(harness.runtimeAuthState?.refreshInFlight).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      `Runtime auth refresh failed for custom-openai: Runtime auth exchange for custom-openai timed out after ${RUNTIME_AUTH_HARD_TIMEOUT_MS}ms`,
    );

    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_RETRY_MS);
    expect(lastRuntimeKey(setRuntimeApiKey)).toBe("retry-runtime-key");
    const writes = setRuntimeApiKey.mock.calls.length;

    lateRefresh.resolve({ apiKey: "late-runtime-key", expiresAt: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(setRuntimeApiKey).toHaveBeenCalledTimes(writes);
    expect(lastRuntimeKey(setRuntimeApiKey)).toBe("retry-runtime-key");
    expect(harness.runtimeAuthState?.expiresAt).toBe(retryExpiresAt);
    controller.stopRuntimeAuthRefreshTimer();
  });

  it("moves to the next profile when credential resolution never settles and drops the late credential", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const setRuntimeApiKey = vi.fn();
    const lateCredential = createDeferred<ResolvedProviderAuth>();
    mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) =>
      profileId === "first" ? await lateCredential.promise : sourceAuth("backup"),
    );
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "backup-runtime-key",
      baseUrl: "https://backup.example.com/v1",
    });
    const controller = createController({
      harness,
      setRuntimeApiKey,
      profileCandidates: ["first", "backup"],
    });

    const init = track(controller.initializeAuthProfile());
    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_HARD_TIMEOUT_MS);
    expect(init).toEqual({ settled: true, value: undefined });

    lateCredential.resolve(sourceAuth("first"));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.lastProfileId).toBe("backup");
    expect(harness.apiKeyInfo?.profileId).toBe("backup");
    expect(harness.runtimeAuthState?.profileId).toBe("backup");
    expect(harness.models.runtime.baseUrl).toBe("https://backup.example.com/v1");
    expect(mocks.prepareProviderRuntimeAuth).toHaveBeenCalledOnce();
    expect(setRuntimeApiKey).toHaveBeenCalledOnce();
    expect(lastRuntimeKey(setRuntimeApiKey)).toBe("backup-runtime-key");
  });

  it("leaves a hung OAuth refresh to its durable owner and adopts the settled rotation", async () => {
    await withOpenClawTestState(
      { label: "auth-controller-deadline", agentEnv: "main" },
      async (state) => {
        const profileId = "synthetic:owner";
        const expired: OAuthCredential = {
          type: "oauth",
          provider: "synthetic",
          access: "synthetic-expired-access",
          refresh: "synthetic-expired-refresh",
          expires: Date.now() - 60_000,
        };
        const rotated: OAuthCredential = {
          ...expired,
          access: "synthetic-rotated-access",
          refresh: "synthetic-rotated-refresh",
          expires: Date.now() + 60 * 60_000,
        };
        await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: expired } });
        const agentDir = state.agentDir();
        const providerStarted = createDeferred();
        const providerResult = createDeferred<OAuthCredential>();
        const refreshCredential = vi.fn(async () => {
          providerStarted.resolve();
          return await providerResult.promise;
        });
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });
        mocks.getApiKeyForModelCore.mockImplementation(async () => {
          const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
          const credential = store.profiles[profileId];
          if (credential?.type !== "oauth") {
            throw new Error("synthetic OAuth profile missing");
          }
          const resolved = await manager.resolveOAuthAccess({
            store,
            profileId,
            credential,
            agentDir,
          });
          return {
            apiKey: resolved?.apiKey,
            mode: "oauth",
            profileId,
            source: `profile:${profileId}`,
          };
        });
        mocks.prepareProviderRuntimeAuth.mockResolvedValue(undefined);
        const readRow = () => loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
        const rowIsPendingFence = () => {
          const row = readRow();
          return row?.type === "oauth" && isPendingOAuthRefreshFence(row);
        };

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const harness = createHarness();
        const setRuntimeApiKey = vi.fn();
        const controller = createController({
          harness,
          setRuntimeApiKey,
          profileCandidates: [profileId],
          agentDir,
        });
        const init = track(controller.initializeAuthProfile());
        try {
          await providerStarted.promise;
          expect(rowIsPendingFence()).toBe(true);

          // The owner's observation deadline releases the caller first; the backstop sits above it.
          await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
          expect(init.settled).toBe(true);
          expect(String(init.error)).toContain(`(${OAUTH_REFRESH_CALL_TIMEOUT_MS}ms)`);
          expect(String(init.error)).not.toContain(`${RUNTIME_AUTH_HARD_TIMEOUT_MS}ms`);
          expect(rowIsPendingFence()).toBe(true);
        } finally {
          // Test-state cleanup drains the owner, so let the provider answer on every path.
          vi.useRealTimers();
          providerResult.resolve(rotated);
        }

        await vi.waitFor(() =>
          expect(readRow()).toMatchObject({ access: rotated.access, refresh: rotated.refresh }),
        );
        expect(setRuntimeApiKey).not.toHaveBeenCalled();
        expect(harness.apiKeyInfo).toBeNull();

        const nextHarness = createHarness();
        const nextSetRuntimeApiKey = vi.fn();
        await createController({
          harness: nextHarness,
          setRuntimeApiKey: nextSetRuntimeApiKey,
          profileCandidates: [profileId],
          agentDir,
        }).initializeAuthProfile();
        expect(nextSetRuntimeApiKey).toHaveBeenCalledWith("custom-openai", rotated.access);
        expect(refreshCredential).toHaveBeenCalledOnce();
        await drainFileLockStateForTest();
      },
    );
  });
});
