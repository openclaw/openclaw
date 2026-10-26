import crypto from "node:crypto";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptNotContinuableError } from "../../packages/agent-core/src/errors.js";
import type { OpenClawConfig } from "../config/config.js";
import { createAgentRunStaleLifecycleError } from "../infra/agent-lifecycle-error.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { resolveEffectiveModelFallbacks } from "./agent-scope.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import {
  markOAuthRefreshFailureSettled,
  OAuthRefreshFailureError,
} from "./auth-profiles/oauth-refresh-failure.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./auth-profiles/oauth-refresh-marker.js";
import { resolveAuthProfileEligibility } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage-state.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { createCliTimeoutError } from "./cli-runner/no-output-timeout-policy.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError } from "./failover-error.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import {
  AgentHarnessPreflightError,
  AgentHarnessSessionSupersededError,
  MissingAgentHarnessError,
  recordAgentHarnessPreflightOwner,
} from "./harness/errors.js";
import { clearAgentHarnesses, registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { isFallbackSummaryError } from "./model-fallback-attempt.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback as runWithModelFallbackBase } from "./model-fallback-runner.js";
import {
  createAgentRunRestartAbortError,
  resolveAgentRunErrorLifecycleFields,
} from "./run-termination.js";
import {
  makeModelFallbackCfg,
  createModelFallbackConfig,
} from "./test-helpers/model-fallback-config-fixture.js";

const emptyManifestPlugins = [] as const;

function resolveFallbackCandidateRefs(params: Parameters<typeof resolveModelCandidateChain>[0]) {
  return resolveModelCandidateChain({ manifestPlugins: emptyManifestPlugins, ...params }).map(
    ({ provider, model }) => ({ provider, model }),
  );
}

vi.mock("../infra/file-lock.js", () => ({
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
}));

const { normalizeModelId } = vi.hoisted(() => ({ normalizeModelId: vi.fn(() => undefined) }));
vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeModelId,
}));

const authSourceCheckMock = vi.hoisted(() => ({
  hasAnyAuthProfileStoreSourceAsync: vi.fn(() => false),
}));

vi.mock("./auth-profiles/source-check.js", () => authSourceCheckMock);

const authRuntimeMock = vi.hoisted(() => {
  // Keep stores in memory while using the canonical cooldown and reason policy.
  const stores = new Map<string, AuthProfileStore>();
  const keyFor = (agentDir?: string) => agentDir ?? "__main__";
  const getStore = (agentDir?: string): AuthProfileStore =>
    stores.get(keyFor(agentDir)) ?? { version: 1, profiles: {} };
  const getProfileIds = (store: AuthProfileStore, provider: string) =>
    Object.entries(store.profiles)
      .filter(([, profile]) => profile.provider === provider)
      .map(([id]) => id);

  return {
    clear: () => stores.clear(),
    setStore: (agentDir: string | undefined, store: AuthProfileStore) => {
      stores.set(keyFor(agentDir), store);
    },
    runtime: {
      ensureAuthProfileStoreAsync: vi.fn((agentDir?: string, _options?: unknown) =>
        getStore(agentDir),
      ),
      loadAuthProfileStoreForRuntimeAsync: vi.fn(async (agentDir?: string) => getStore(agentDir)),
      resolveAuthProfileOrder: vi.fn(
        (params: {
          store: AuthProfileStore;
          provider: string;
          includePendingOAuthRefresh?: boolean;
        }) =>
          (
            params.store.order?.[params.provider] ?? getProfileIds(params.store, params.provider)
          ).filter((profileId) => {
            const credential = params.store.profiles[profileId];
            if (credential?.type !== "oauth" || !isOAuthRefreshFence(credential)) {
              return true;
            }
            return (
              params.includePendingOAuthRefresh === true && isPendingOAuthRefreshFence(credential)
            );
          }),
      ),
      resolveAuthProfileEligibility: (
        params: Parameters<typeof resolveAuthProfileEligibility>[0],
      ) => resolveAuthProfileEligibility(params),
      maybeReprobeWhamBlockedProfiles: vi.fn(),
      isProfileInCooldown: (...args: Parameters<typeof isProfileInCooldown>) =>
        isProfileInCooldown(...args),
      resolveProfilesUnavailableReason: (
        ...args: Parameters<typeof resolveProfilesUnavailableReason>
      ) => resolveProfilesUnavailableReason(...args),
      getSoonestCooldownExpiry: (...args: Parameters<typeof getSoonestCooldownExpiry>) =>
        getSoonestCooldownExpiry(...args),
    },
  };
});

vi.mock("./auth-profiles.runtime.js", () => authRuntimeMock.runtime);

const makeCfg = makeModelFallbackCfg;
let authTempCounter = 0;

function registerFallbackHarness(id: string): void {
  registerAgentHarness(
    {
      id,
      label: id,
      supports: () => ({ supported: true }),
      runAttempt: vi.fn<AgentHarness["runAttempt"]>(async () => {
        throw new Error("fallback test should not invoke the registered harness directly");
      }),
    },
    { ownerPluginId: `${id}-test` },
  );
}

function createHarnessScopedPreflightError(harnessId: string): AgentHarnessPreflightError {
  const error = new AgentHarnessPreflightError("Codex approvals denied execution", {
    scope: "harness",
  });
  recordAgentHarnessPreflightOwner(error, harnessId);
  return error;
}

type FallbackParams<T> = Parameters<typeof runWithModelFallbackBase<T>>[0];
function runWithModelFallback<T>(
  params: Omit<FallbackParams<T>, "cfg" | "provider" | "model"> &
    Partial<Pick<FallbackParams<T>, "cfg" | "provider" | "model">>,
) {
  return runWithModelFallbackBase({
    cfg: makeCfg(),
    provider: "openai",
    model: "gpt-4.1-mini",
    manifestPlugins: emptyManifestPlugins,
    ...params,
  });
}

afterEach(() => {
  normalizeModelId.mockClear();
  resetFallbackSkipCacheForTest();
  clearAgentHarnesses();
  authRuntimeMock.clear();
  authRuntimeMock.runtime.ensureAuthProfileStoreAsync.mockClear();
  authRuntimeMock.runtime.loadAuthProfileStoreForRuntimeAsync.mockClear();
  authRuntimeMock.runtime.resolveAuthProfileOrder.mockClear();
  authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockReset();
  authSourceCheckMock.hasAnyAuthProfileStoreSourceAsync.mockReset().mockReturnValue(false);
  resetDiagnosticEventsForTest();
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
});

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

function makeProviderFallbackCfg(provider: string): OpenClawConfig {
  return createModelFallbackConfig(`${provider}/m1`, ["fallback/ok-model"]);
}

function configuredFallback(primary: string, fallbacks: string[]) {
  const separator = primary.indexOf("/");
  return {
    cfg: createModelFallbackConfig(primary, fallbacks),
    provider: primary.slice(0, separator),
    model: primary.slice(separator + 1),
  };
}

function recoverAfter(error: unknown, result = "ok") {
  return vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(result);
}

function failInOrder(...errors: unknown[]) {
  const run = vi.fn();
  for (const error of errors) {
    run.mockRejectedValueOnce(error);
  }
  return run;
}

function namedError(name: string, message: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name });
}

function cooldown(cooldownUntil: number, cooldownModel: string) {
  return {
    cooldownUntil,
    cooldownModel,
    cooldownReason: "rate_limit" as const,
    lastRateLimitAt: 1,
  };
}

function apiKeyStore(
  providers: string[],
  usageStats?: AuthProfileStore["usageStats"],
): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:default`,
        createApiKeyCredential(provider, "test-key"),
      ]),
    ),
    usageStats,
  };
}

function oauthCredential(provider: string) {
  return {
    type: "oauth" as const,
    provider,
    access: "expired-access",
    refresh: "refresh-token",
    expires: 1,
  };
}

function makeProviderOrderFallbackCfg(
  entries: Array<[provider: string, model: string]>,
): OpenClawConfig {
  return {
    models: {
      providers: Object.fromEntries(
        entries.map(([provider, model]) => [
          provider,
          {
            baseUrl: `https://${provider}.example.test`,
            models: [{ id: model }],
          },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

function installAuthStore(store: AuthProfileStore): string {
  const dir = path.join("/tmp/openclaw-auth-suite-mock", `case-${++authTempCounter}`);
  setAuthRuntimeStore(dir, store);
  return dir;
}

async function runWithStoredAuth(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  run: (provider: string, model: string) => Promise<string>;
  userLockedAuthProfileId?: string;
}) {
  const tempDir = installAuthStore(params.store);
  return await runWithModelFallback({
    cfg: params.cfg ?? makeProviderFallbackCfg(params.provider),
    provider: params.provider,
    model: "m1",
    agentDir: tempDir,
    run: params.run,
    userLockedAuthProfileId: params.userLockedAuthProfileId,
  });
}

function setAuthRuntimeStore(agentDir: string | undefined, store: AuthProfileStore): void {
  authSourceCheckMock.hasAnyAuthProfileStoreSourceAsync.mockReturnValue(true);
  authRuntimeMock.setStore(agentDir, store);
}

async function expectFallbackSummary(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert(isFallbackSummaryError(error));
    return error;
  }
  throw new Error("expected fallback summary");
}

function createFallbackOnlyRun() {
  return vi.fn().mockImplementation(async (providerId, modelId) => {
    if (providerId === "fallback") {
      return "ok";
    }
    throw new Error(`unexpected provider: ${providerId}/${modelId}`);
  });
}

// Issue-backed Anthropic/OpenAI-compatible insufficient_quota payload under HTTP 400:
// https://github.com/openclaw/openclaw/issues/23440
const INSUFFICIENT_QUOTA_PAYLOAD =
  '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}';

type ModelFailoverDiagnostic = Extract<DiagnosticEventPayload, { type: "model.failover" }>;

function captureModelFailoverDiagnostics(): {
  events: ModelFailoverDiagnostic[];
  stop: () => void;
} {
  const events: ModelFailoverDiagnostic[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.failover") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("runWithModelFallback", () => {
  it("does not replay a thrown attempt after the caller reports a committed side effect", async () => {
    const failure = new FailoverError("primary failed after tool start", {
      provider: "openai",
      model: "gpt-5.4",
      reason: "overloaded",
    });
    const run = vi.fn().mockRejectedValue(failure);
    const canFallbackAfterError = vi.fn().mockReturnValue(false);

    await expect(
      runWithModelFallback({
        cfg: createModelFallbackConfig("openai/gpt-5.5", ["anthropic/claude-opus-4-7"]),
        model: "gpt-5.4",
        run,
        canFallbackAfterError,
      }),
    ).rejects.toBe(failure);

    expect(run).toHaveBeenCalledTimes(1);
    expect(canFallbackAfterError).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-5.4", error: failure }),
    );
  });

  it("keeps TLS-failed providers excluded across interleaved fallbacks", async () => {
    const diagnostics = captureModelFailoverDiagnostics();
    const run = failInOrder(
      new FailoverError("Hostname/IP does not match certificate's altnames", {
        provider: "openai",
        model: "gpt-5.5",
        reason: "tls_certificate",
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      }),
      new FailoverError("overloaded", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        reason: "overloaded",
      }),
    ).mockResolvedValueOnce("must not run");
    try {
      await expectFallbackSummary(
        runWithModelFallback({
          ...configuredFallback("openai/gpt-5.5", [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.5-mini",
          ]),
          sessionId: "session:tls-provider-exclusion",
          sessionKey: "agent:test:tls-provider-exclusion",
          lane: "main",
          run,
        }),
      );
    } finally {
      diagnostics.stop();
    }

    expect(run.mock.calls).toMatchObject([
      ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-opus-4-6", { isFinalFallbackAttempt: true }],
    ]);
    expect(diagnostics.events).toHaveLength(1);
    expect(diagnostics.events).toMatchObject([
      {
        fromProvider: "openai",
        fromModel: "gpt-5.5",
        toProvider: "anthropic",
        toModel: "claude-opus-4-6",
        reason: "tls_certificate",
      },
    ]);
  });

  it("preserves local profile absence without provider reauthentication", async () => {
    const status = 401;
    const code = "selected_auth_profile_unavailable";
    const run = failInOrder(
      Object.assign(new Error("primary selected profile missing"), { code, status }),
      Object.assign(new Error("fallback selected profile missing"), { code, status }),
    );

    const error = await expectFallbackSummary(
      runWithModelFallback({
        ...configuredFallback("openai/gpt-5.5", ["anthropic/claude-opus-4-6"]),
        run,
      }),
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ reason: "auth", code });
    expect(error.status).toBeUndefined();
    expect(error.attempts).toMatchObject([
      { code, error: "primary selected profile missing", status: undefined },
      { code, error: "fallback selected profile missing", status: undefined },
    ]);
    expect(error.message).not.toMatch(/HTTP 401|re-authenticate|Authentication failed/i);
  });

  it.each(["harness-owned explicit", "automatic"] as const)(
    "scopes auth skip markers to the selected profile: %s",
    async (mode) => {
      vi.stubEnv("OPENCLAW_FALLBACK_SKIP_TTL_MS", "60000");
      const provider = `auth-skip-${crypto.randomUUID()}`;
      const automatic = mode === "automatic";
      const harness = mode === "harness-owned explicit";
      if (harness) {
        registerFallbackHarness("codex");
      }
      const profileA = `${provider}:a`;
      const profileB = `${provider}:b`;
      const lockedProfile = "openai:locked";
      let selectedProfile = profileA;
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [profileA]: createApiKeyCredential(provider, "key-a"),
          [profileB]: createApiKeyCredential(provider, "key-b"),
          ...(automatic ? { [lockedProfile]: createApiKeyCredential("openai", "key-locked") } : {}),
        },
        ...(automatic ? { order: { [provider]: [profileA, profileB] } } : {}),
      };
      const agentDir = installAuthStore(store);
      const cfg = createModelFallbackConfig("openai/m1", [`${provider}/m1`, "fallback/ok-model"]);
      const run = vi.fn(async (candidateProvider: string, model: string) => {
        if (candidateProvider === "openai" || candidateProvider === provider) {
          throw new FailoverError("selected profile failed", {
            provider: candidateProvider,
            model,
            reason: candidateProvider === "openai" ? "rate_limit" : "auth",
            ...(automatic && candidateProvider === provider ? { profileId: selectedProfile } : {}),
          });
        }
        return "ok";
      });
      const execute = () =>
        runWithModelFallback({
          cfg,
          model: "m1",
          sessionId: "session:scoped-auth-skip",
          agentDir,
          userLockedAuthProfileId: automatic ? lockedProfile : selectedProfile,
          resolveAgentHarnessRuntimeOverride: (candidateProvider) =>
            harness && candidateProvider === provider ? "codex" : undefined,
          run,
        });
      await execute();
      selectedProfile = profileB;
      if (automatic) {
        store.order = { [provider]: [profileB, profileA] };
      }
      await execute();
      const third = await execute();
      expect(third.result).toBe("ok");
      expect(run.mock.calls.map(([candidateProvider]) => candidateProvider)).toEqual([
        "openai",
        provider,
        "fallback",
        "openai",
        provider,
        "fallback",
        "openai",
        "fallback",
      ]);
      expect(third.attempts.find((attempt) => attempt.provider === provider)?.error).toContain(
        "recent auth failure",
      );
    },
  );

  // Transport harnesses preserve provider ceiling figures only in rawError after replacing
  // the visible message with context-overflow copy (#130096).
  const GROQ_REQUEST_CEILING_413 =
    "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
    "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
    "please reduce your message size and try again.";

  function makeNormalizedOverflowFailover(rawError?: string) {
    return new FailoverError(
      "Context overflow: prompt too large for the model. " +
        "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      { reason: "context_overflow", provider: "groq", model: "openai/gpt-oss-120b", rawError },
    );
  }

  it.each([
    {
      name: "provider request-size ceiling",
      error: () => makeNormalizedOverflowFailover(GROQ_REQUEST_CEILING_413),
      reason: "context_overflow",
    },
    {
      name: "HTTP 400 insufficient_quota payload",
      error: () => Object.assign(new Error(INSUFFICIENT_QUOTA_PAYLOAD), { status: 400 }),
      reason: "billing",
    },
  ])("continues configured fallback after $name", async ({ error, reason }) => {
    const run = recoverAfter(error());

    const result = await runWithModelFallback({ run });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe(reason);
  });

  it.each([
    [
      "missing tool result",
      () =>
        new Error(
          "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.",
        ),
    ],
    ["missing strict harness", () => new MissingAgentHarnessError("codex")],
    [
      "superseded harness session",
      () =>
        new AgentHarnessSessionSupersededError(
          "Codex session generation is no longer current: session-old",
        ),
    ],
    [
      "writer claim rebound",
      () =>
        new Error("provider rejected request: rate limit", {
          cause: Object.assign(
            new Error("session writer claim changed before transcript persistence"),
            { name: "SessionTranscriptWriterClaimReboundError" },
          ),
        }),
    ],
    [
      "stale gateway lifecycle (#116418)",
      () => namedError("AbortError", "request was aborted", createAgentRunStaleLifecycleError()),
    ],
    [
      "gateway drain in an aggregate",
      () =>
        new AggregateError(
          [new Error("cleanup failed"), new GatewayDrainingError()],
          "agent run failed",
        ),
    ],
    ["transcript continuation", () => new TranscriptNotContinuableError("assistant")],
    [
      "abortable client disconnect",
      async () => {
        const controller = new AbortController();
        const disconnect = namedError("ClientDisconnectError", "client disconnected");
        controller.abort(disconnect);
        try {
          await abortable(controller.signal, Promise.resolve());
        } catch (error: unknown) {
          assert(error instanceof Error);
          return error;
        }
        throw new Error("abortable() unexpectedly resolved after abort");
      },
    ],
    [
      "unmarked restart abort wrapper",
      () => namedError("AbortError", "aborted", createAgentRunRestartAbortError()),
    ],
  ])("stops fallback for %s without provider-failure attribution", async (_name, makeError) => {
    const error = await makeError();
    const run = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const onFallbackStep = vi.fn();
    await expect(runWithModelFallback({ run, onError, onFallbackStep })).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalled();
  });

  it("fails closed before auth cooldown skips when a strict plugin harness is missing", async () => {
    const cfg = makeCfg({
      ...createModelFallbackConfig("openai/gpt-5.5", ["anthropic/claude-sonnet-4-6"]),
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "codex" },
            models: [],
          },
        },
      },
    });
    const tempDir = installAuthStore(
      apiKeyStore(["openai", "anthropic"], {
        "openai:default": {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          lastRateLimitAt: Date.now(),
        },
      }),
    );
    const run = vi.fn().mockResolvedValueOnce("wrong fallback");

    await expect(
      runWithModelFallback({ cfg, model: "gpt-5.5", agentDir: tempDir, run }),
    ).rejects.toThrow('Requested agent harness "codex" is not registered.');
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "anthropic", model: "claude-sonnet-4-6", runtime: "claude-cli" },
    { provider: "claude-cli", model: "opus", runtime: undefined },
  ])(
    "lets $runtime/$provider own auth despite provider cooldown",
    async ({ provider, model, runtime }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: `${provider}/${model}` },
            ...(runtime ? { models: { "anthropic/*": { agentRuntime: { id: runtime } } } } : {}),
          },
        },
      };
      const agentDir = installAuthStore(
        apiKeyStore([provider, "openai"], {
          [`${provider}:default`]: {
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
            failureCounts: { billing: 4 },
          },
        }),
      );
      const run = vi.fn(async (candidate: string) => {
        if (candidate !== provider) {
          throw new Error(`unexpected provider: ${candidate}`);
        }
        return "ok";
      });
      const result = await runWithModelFallback({ cfg, provider, model, agentDir, run });
      expect(result.result).toBe("ok");
      expect(run.mock.calls).toMatchObject([[provider, model, { isFinalFallbackAttempt: true }]]);
      expect(result.attempts).toStrictEqual([]);
    },
  );

  it.each([false, true])(
    "skips failed-harness candidates (another harness available=%s)",
    async (alternative) => {
      registerFallbackHarness("codex");
      const preflightError = createHarnessScopedPreflightError("codex");
      const run = alternative
        ? recoverAfter(preflightError, "openclaw-ok")
        : vi.fn().mockRejectedValue(preflightError);
      const onFallbackStep = vi.fn();
      const pending = runWithModelFallback({
        model: "gpt-5.5",
        fallbacksOverride: [
          "openai/gpt-5.4",
          alternative ? "anthropic/claude-sonnet-4-6" : "openai/gpt-5.3",
        ],
        resolveAgentHarnessRuntimeOverride: (provider) =>
          alternative && provider !== "openai" ? "openclaw" : "codex",
        onFallbackStep,
        run,
      });
      if (!alternative) {
        await expect(pending).rejects.toBe(preflightError);
        expect(run).toHaveBeenCalledOnce();
        expect(onFallbackStep).not.toHaveBeenCalled();
        return;
      }
      expect((await pending).result).toBe("openclaw-ok");
      expect(run.mock.calls).toMatchObject([
        ["openai", "gpt-5.5", { isFinalFallbackAttempt: false }],
        ["anthropic", "claude-sonnet-4-6", { isFinalFallbackAttempt: true }],
      ]);
      expect(onFallbackStep).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          fallbackStepFromModel: "openai/gpt-5.5",
          fallbackStepToModel: "anthropic/claude-sonnet-4-6",
          fallbackStepFinalOutcome: "next_fallback",
        }),
      );
    },
  );

  it("keeps raw provider schema errors in fallback summaries", async () => {
    const rawError =
      "400 The following tools cannot be used with reasoning.effort 'minimal': web_search.";
    const run = vi.fn().mockRejectedValue(
      new FailoverError("LLM request failed: provider rejected the request schema.", {
        provider: "openai",
        model: "gpt-5.4",
        reason: "format",
        status: 400,
        rawError,
      }),
    );

    const error = await expectFallbackSummary(
      runWithModelFallback({
        ...configuredFallback("openai/gpt-5.4", ["openai/gpt-5.4-mini"]),
        run,
      }),
    );
    expect(error.name).toBe("FailoverError");
    expect(error.message).toContain(rawError);
    const attempt = error.attempts.find((candidate) => candidate.error === rawError);
    expect(attempt).toMatchObject({ reason: "format", status: 400 });
  });

  it.each([false, true])(
    "attributes the final failed candidate after fallback (watchdog=%s)",
    async (watchdog) => {
      const timeout = createCliTimeoutError(
        {},
        {
          mode: "no-output",
          timeoutSeconds: 30,
          observedActivity: false,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      );
      const providerFailure = Object.assign(new Error("500 upstream failure"), { status: 500 });
      const run = failInOrder(
        ...(watchdog ? [providerFailure, timeout] : [timeout, providerFailure]),
      );
      const error = await expectFallbackSummary(
        runWithModelFallback({
          ...configuredFallback("anthropic/claude-opus-4-7", ["google/gemini-3-pro-preview"]),
          run,
        }),
      );

      expect(run).toHaveBeenCalledTimes(2);
      expect(error.attempts.map(({ status }) => status)).toEqual(
        watchdog ? [500, 408] : [408, 500],
      );
      expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toEqual(
        watchdog ? { stopReason: "timeout", timeoutPhase: "provider" } : {},
      );
    },
  );

  it("carries request attribution through exhausted fallback summaries", async () => {
    const run = failInOrder(
      Object.assign(new Error("rate limit exceeded"), { status: 429 }),
      Object.assign(new Error("overloaded"), { status: 503 }),
    );

    const summary = await expectFallbackSummary(
      runWithModelFallback({
        ...configuredFallback("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]),
        runId: "run-42713",
        sessionId: "session:browser-42713",
        lane: "answer",
        run,
      }),
    );
    const attribution = {
      name: "FailoverError",
      sessionId: "session:browser-42713",
      lane: "answer",
    };
    expect(summary).toMatchObject(attribution);
    const cause = summary.cause;
    assert(cause instanceof FailoverError);
    expect(cause).toMatchObject(attribution);
  });

  it("continues fallback after embedded provider business-denial payloads", async () => {
    const rawError =
      '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}';
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        payloads: [{ text: rawError, isError: true }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult)
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback ok" }],
        meta: { durationMs: 1 },
      } satisfies EmbeddedAgentRunResult);

    const result = await runWithModelFallback<EmbeddedAgentRunResult>({
      ...configuredFallback("zai/glm-5.1", ["openai/gpt-5.5"]),
      run,
      classifyResult: classifyEmbeddedAgentRunResultForModelFallback,
    });

    expect(result.result.payloads).toEqual([{ text: "fallback ok" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toMatchObject([
      "openai",
      "gpt-5.5",
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts[0]).toMatchObject({
      provider: "zai",
      model: "glm-5.1",
      reason: "auth",
      code: "embedded_error_payload",
      error: rawError,
    });
  });

  it("throws unrecognized error on last candidate", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("something weird"));

    await expect(runWithModelFallback({ run, fallbacksOverride: [] })).rejects.toThrow(
      "something weird",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("executes fallback aliases in the selected agent scope", async () => {
    const cfg = makeCfg({
      agents: {
        entries: {
          main: {},
          worker: { models: { "anthropic/worker-fallback": { alias: "fast" } } },
        },
        defaults: {
          model: { primary: "openai/primary", fallbacks: ["fast"] },
          models: { "openai/global-fallback": { alias: "fast" } },
        },
      },
    });

    const run = recoverAfter(
      new FailoverError("primary rate limited", {
        reason: "rate_limit",
        provider: "openai",
        model: "primary",
      }),
      "worker fallback",
    );
    const result = await runWithModelFallback({
      cfg,
      agentId: "worker",
      model: "primary",
      skipAuthProfileRuntime: true,
      run,
    });

    expect(result.result).toBe("worker fallback");
    expect(run.mock.calls[1]).toMatchObject([
      "anthropic",
      "worker-fallback",
      { isFinalFallbackAttempt: true },
    ]);
  });

  it("tries inherited fallbacks before primary for override credential validation errors", async () => {
    const cfg = makeCfg();
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === "anthropic" && model === "claude-opus-4") {
        throw new Error('No credentials found for profile "anthropic:default".');
      }
      if (provider === "openai" && model === "gpt-4.1-mini") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });

    const result = await runWithModelFallback({
      cfg,
      fallbacksOverride: resolveEffectiveModelFallbacks({
        cfg,
        agentId: "main",
        hasSessionModelOverride: false,
      }),
      provider: "anthropic",
      model: "claude-opus-4",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toMatchObject([
      ["anthropic", "claude-opus-4", { isFinalFallbackAttempt: false }],
      ["anthropic", "claude-haiku-3-5", { isFinalFallbackAttempt: false }],
      ["openai", "gpt-4.1-mini", { isFinalFallbackAttempt: true }],
    ]);
  });

  it("preserves auth mode metadata after fallback exhaustion", async () => {
    const run = vi.fn().mockRejectedValue(
      new FailoverError("OpenAI OAuth unavailable", {
        reason: "auth_permanent",
        provider: "openai",
        authMode: "oauth",
      }),
    );

    const error = await expectFallbackSummary(
      runWithModelFallback({
        ...configuredFallback("openai/gpt-5.6-sol", ["openai/gpt-5.6-terra"]),
        run,
      }),
    );

    expect(error.authMode).toBe("oauth");
    expect(error.attempts).toMatchObject([{ authMode: "oauth" }, { authMode: "oauth" }]);
  });

  it("sanitizes model identifiers in model_not_found warnings", async () => {
    const warnLogs = createWarnLogCapture("openclaw-model-fallback-test");
    try {
      const run = recoverAfter(new Error("Model not found: openai/gpt-6"));

      const result = await runWithModelFallback({ model: "gpt-6\u001B[31m\nspoof", run });

      expect(result.result).toBe("ok");
      const warning = await warnLogs.findText('Model "openai/gpt-6spoof" not found');
      expect(warning).toContain('Model "openai/gpt-6spoof" not found');
      expect(warning).not.toContain("\u001B");
      expect(warning).not.toContain("\n");
    } finally {
      warnLogs.cleanup();
    }
  });

  it.each(["cooldown", "auth-disabled"] as const)(
    "skips unavailable profiles and preserves auth metadata: %s",
    async (state) => {
      const oauth = state === "auth-disabled";
      const provider = `${oauth ? "auth-disabled" : "cooldown-test"}-${crypto.randomUUID()}`;
      const profileId = `${provider}:default`;
      const store = apiKeyStore(["fallback", provider], {
        [profileId]: oauth
          ? { disabledUntil: Date.now() + 5 * 60_000, disabledReason: "auth_permanent" }
          : { cooldownUntil: Date.now() + 5 * 60_000 },
      });
      if (oauth) {
        store.profiles[profileId] = {
          ...oauthCredential(provider),
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        };
      }
      const run = createFallbackOnlyRun();
      const result = await runWithStoredAuth({ store, provider, run });
      expect(result.result).toBe("ok");
      expect(run.mock.calls).toMatchObject([
        ["fallback", "ok-model", { isFinalFallbackAttempt: true }],
      ]);
      expect(result.attempts[0]?.reason).toBe(oauth ? "auth_permanent" : "unknown");
      expect(result.attempts[0]?.authMode).toBe(oauth ? "oauth" : undefined);
    },
  );

  it("keeps a pending OAuth user lock in the fallback auth scope", async () => {
    const provider = `pending-lock-${crypto.randomUUID()}`;
    const pendingProfileId = `${provider}:pending`;
    const backupProfileId = `${provider}:backup`;
    const pending = createOAuthRefreshFence({
      profileId: pendingProfileId,
      credential: oauthCredential(provider),
    });
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [pendingProfileId]: pending,
        [backupProfileId]: createApiKeyCredential(provider, "backup-key"),
        "fallback:default": createApiKeyCredential("fallback", "fallback-key"),
      },
      order: { [provider]: [backupProfileId] },
      usageStats: { [backupProfileId]: { cooldownUntil: Date.now() + 60_000 } },
    };
    const run = vi.fn().mockResolvedValue("ok");

    const result = await runWithStoredAuth({
      store,
      provider,
      run,
      userLockedAuthProfileId: pendingProfileId,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toMatchObject([[provider, "m1", { isFinalFallbackAttempt: false }]]);
    expect(authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ profileIds: [pendingProfileId, backupProfileId] }),
    );
    expect(store.order?.[provider]).toEqual([backupProfileId]);
    expect(authRuntimeMock.runtime.ensureAuthProfileStoreAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        profileId: pendingProfileId,
        externalCli: expect.objectContaining({
          mode: "scoped",
          allowKeychainPrompt: false,
          profileIds: [pendingProfileId],
        }),
      }),
    );
  });

  it.each(["persisted during attempt", "scoped to attempted model"] as const)(
    "resolves fallback summary cooldown expiry: %s",
    async (state) => {
      const now = Date.now();
      const expiry = now + 120_000;
      const store = apiKeyStore(
        ["anthropic", "openai"],
        state === "scoped to attempted model"
          ? {
              "anthropic:default": cooldown(now + 15_000, "claude-haiku-3-5"),
              "openai:default": cooldown(expiry, "gpt-5.2"),
            }
          : undefined,
      );

      const tempDir = installAuthStore(store);
      const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
        if (
          state === "persisted during attempt" &&
          provider === "anthropic" &&
          model === "claude-opus-4-5"
        ) {
          setAuthRuntimeStore(tempDir, {
            ...store,
            usageStats: {
              "anthropic:default": cooldown(expiry, "claude-opus-4-5"),
            },
          });
        }

        throw Object.assign(new Error("rate limited"), { status: 429 });
      });

      const error = await expectFallbackSummary(
        runWithModelFallback({
          ...configuredFallback("anthropic/claude-opus-4-5", ["openai/gpt-5.2"]),
          agentDir: tempDir,
          run,
        }),
      );
      expect(error.name).toBe("FailoverError");
      expect(error.soonestCooldownExpiry).toBe(expiry);
    },
  );

  it("resolves a raw slash-form alias before provider parsing", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/vendor/model", fallbacks: [] },
          models: { "openai/vendor/model": { alias: "vendor/model" } },
        },
      },
    };
    expect(resolveFallbackCandidateRefs({ cfg, provider: "vendor", model: "model" })).toEqual([
      { provider: "openai", model: "vendor/model" },
    ]);
  });

  it("does not reuse provider-order-sensitive configured fallback candidates", () => {
    const resolve = (cfg: OpenClawConfig) =>
      resolveFallbackCandidateRefs({ cfg, provider: "", model: "", fallbacksOverride: [] });
    const anthropicFirst = makeProviderOrderFallbackCfg([
      ["anthropic", "claude-sonnet-4"],
      ["ollama", "llama3"],
    ]);
    const ollamaFirst = makeProviderOrderFallbackCfg([
      ["ollama", "llama3"],
      ["anthropic", "claude-sonnet-4"],
    ]);

    expect(resolve(anthropicFirst)).toEqual([{ provider: "anthropic", model: "claude-sonnet-4" }]);
    expect(resolve(ollamaFirst)).toEqual([{ provider: "ollama", model: "llama3" }]);
  });

  it("does not fall back when a timed-out caller abort is classified from the result", async () => {
    const cfg = makeProviderFallbackCfg("openai");
    const timeoutReason = namedError("TimeoutError", "chat run timed out");
    const controller = new AbortController();
    controller.abort(timeoutReason);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ payloads: [] })
      .mockResolvedValueOnce({ payloads: [{ text: "fallback should not run" }] });
    const classifyResult = vi.fn(() => ({
      message: "This operation was aborted",
      reason: "timeout" as const,
      code: "terminal_abort",
    }));

    await expect(
      runWithModelFallback({
        cfg,
        model: "m1",
        abortSignal: controller.signal,
        run,
        classifyResult,
      }),
    ).rejects.toThrow("This operation was aborted");

    expect(run).toHaveBeenCalledTimes(1);
    expect(classifyResult).toHaveBeenCalledTimes(1);
  });

  it("limits cooldown probes to one per provider before moving to cross-provider fallback", async () => {
    const dir = installAuthStore(
      apiKeyStore(["anthropic"], {
        "anthropic:default": {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
        },
      }),
    );

    const run = recoverAfter(new Error("Still rate limited"), "groq success");

    const result = await runWithModelFallback({
      ...configuredFallback("anthropic/claude-opus-4-6", [
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-haiku-3-5",
        "groq/openai/gpt-oss-120b",
      ]),
      run,
      agentDir: dir,
    });

    expect(result.result).toBe("groq success");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls).toMatchObject([
      [
        "anthropic",
        "claude-opus-4-6",
        { allowTransientCooldownProbe: true, isFinalFallbackAttempt: false },
      ],
      ["groq", "openai/gpt-oss-120b", { isFinalFallbackAttempt: true }],
    ]);
  });

  it("falls back normally when a provider wraps its own timeout as AbortError(cause: TimeoutError) WITHOUT the abortable() marker", async () => {
    const unmarkedAbortError = namedError(
      "AbortError",
      "aborted",
      namedError("TimeoutError", "provider request timed out after 60s"),
    );
    const run = recoverAfter(unmarkedAbortError);

    const result = await runWithModelFallback({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

it("runWithImageModelFallback preserves cancellation without starting a fallback", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled image fallback");
  const run = vi.fn(async () => {
    controller.abort(reason);
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });

  await expect(
    runWithImageModelFallback({
      cfg: makeCfg({
        agents: {
          defaults: {
            imageModel: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["google/gemini-2.5-flash"],
            },
          },
        },
      }),
      abortSignal: controller.signal,
      run,
    }),
  ).rejects.toBe(reason);

  expect(run).toHaveBeenCalledOnce();
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("model fallback live selection", () => {
  const switchTarget = { provider: "anthropic", model: "claude-sonnet-4-6" };
  it.each([true, false])(
    "handles a live switch on the last candidate (target selected=%s)",
    async (selected) => {
      const switchError = new LiveSessionModelSwitchError(switchTarget);
      const run = vi.fn().mockRejectedValue(switchError);
      const error = await runWithModelFallback({
        skipAuthProfileRuntime: true,
        fallbacksOverride: [],
        ...(selected ? switchTarget : {}),
        run,
      }).catch((caught: unknown) => caught);
      if (selected) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LiveSessionModelSwitchError);
        expect(error).toMatchObject({ reason: "unknown" });
      } else {
        expect(error).toBe(switchError);
      }
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("preserves a later live-session model switch through subsequent failure (#57471)", async () => {
    const switchError = new LiveSessionModelSwitchError(switchTarget);
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === "openai" && model === "gpt-4.1-mini") {
        throw switchError;
      }
      if (provider === "anthropic" && model === "claude-sonnet-4-6") {
        throw new FailoverError("rate limited", { reason: "rate_limit", provider, model });
      }
      if (provider === "openrouter" && model === "openrouter/deepseek-chat") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });
    const onError = vi.fn();

    const result = await runWithModelFallback({
      ...configuredFallback("openai/gpt-4.1-mini", [
        "anthropic/claude-haiku-3-5",
        "anthropic/claude-sonnet-4-6",
        "openrouter/deepseek-chat",
      ]),
      skipAuthProfileRuntime: true,
      run,
      onError,
    });
    expect(result).toMatchObject({
      result: "ok",
      provider: "openrouter",
      model: "openrouter/deepseek-chat",
      attempts: [{ provider: "anthropic", model: "claude-sonnet-4-6", reason: "rate_limit" }],
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(run.mock.calls).toMatchObject([
      [
        "openai",
        "gpt-4.1-mini",
        { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: false } },
      ],
      [
        "anthropic",
        "claude-sonnet-4-6",
        { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: true } },
      ],
      [
        "openrouter",
        "openrouter/deepseek-chat",
        { isFinalFallbackAttempt: true, modelRoutingProvenance: { selectionChanged: true } },
      ],
    ]);
  });

  it("returns runtime-changing live switches to the retry owner before redirecting", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntimeOverride: "codex",
    });
    const run = vi.fn().mockRejectedValue(switchError);

    await expect(
      runWithModelFallback({
        skipAuthProfileRuntime: true,
        ...configuredFallback("anthropic/claude-haiku-3-5", ["openai/gpt-5.6-luna"]),
        resolveAgentHarnessRuntimeOverride: (provider) =>
          provider === "openai" ? "openclaw" : undefined,
        run,
      }),
    ).rejects.toBe(switchError);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runWithModelFallback quota recovery", () => {
  const profileId = "openai:default";
  const credential = { ...oauthCredential("openai"), refresh: "synthetic-refresh" };
  const fallbackOptions = configuredFallback("openai/m1", ["fallback/ok-model"]);

  beforeEach(() => setAuthRuntimeStore(undefined, { version: AUTH_STORE_VERSION, profiles: {} }));
  it("keeps normal auth failure under the existing fallback policy after quota refresh", async () => {
    const error = new OAuthRefreshFailureError({
      provider: "openai",
      profileId,
      message: "OAuth token refresh failed for openai: invalid_grant",
      reason: "invalid_grant",
    });
    markOAuthRefreshFailureSettled(error);
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockResolvedValueOnce({
      requiresAuthPreparation: true,
    });
    setAuthRuntimeStore(undefined, {
      version: AUTH_STORE_VERSION,
      profiles: { [profileId]: credential },
    });
    const run = vi.fn(async (provider: string) => {
      if (provider === "openai") {
        throw error;
      }
      return "backup reply";
    });
    const canFallbackAfterError = vi.fn(({ error: _error }: { error: unknown }) => true);
    const result = await runWithModelFallback({ ...fallbackOptions, run, canFallbackAfterError });
    expect(result.result).toBe("backup reply");
    expect(run.mock.calls).toEqual([
      ["openai", "m1", expect.any(Object)],
      ["fallback", "ok-model", expect.any(Object)],
    ]);
    const normalizedFailure = canFallbackAfterError.mock.calls[0]?.[0].error;
    assert(normalizedFailure instanceof FailoverError);
    expect(normalizedFailure).toMatchObject({
      reason: "auth_permanent",
      status: 403,
      provider: "openai",
      model: "m1",
      rawError: error.message,
    });
    expect(normalizedFailure.cause).toBe(error);
    expect(canFallbackAfterError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        error: normalizedFailure,
        provider: "openai",
        model: "m1",
        attempt: 1,
        total: 2,
      }),
    );
  });

  it("keeps declared direct credentials after quota recovery instead of using a fallback", async () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        [profileId]: credential,
        "fallback:default": { type: "api_key", provider: "fallback", key: "fallback-key" },
      },
      usageStats: {
        [profileId]: {
          blockedUntil: Date.now() + 86_400_000,
          blockedReason: "subscription_limit",
          blockedSource: "wham",
        },
      },
    };
    setAuthRuntimeStore(undefined, store);
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockImplementationOnce(async () => {
      store.profiles[profileId] = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({ profileId, credential }),
      );
      return { requiresAuthPreparation: true };
    });
    const cfg: OpenClawConfig = {
      ...createModelFallbackConfig("openai/gpt-5.5", ["fallback/ok-model"]),
      models: {
        providers: { openai: { apiKey: "configured-platform-key", baseUrl: "", models: [] } },
      },
    };
    const { prepareAuthFixture } = await import("./runtime-plan/prepare-auth.test-support.js");
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider !== "openai") {
        return "fallback reply";
      }
      const prepared = prepareAuthFixture({
        provider,
        modelId: model,
        config: cfg,
        env: {},
        authProfileStore: store,
      });
      expect(prepared.attempts).toMatchObject([
        { kind: "direct", requiresPriorProfileAttempt: false },
      ]);
      expect(prepared.plan.credentialSource).toEqual({
        kind: "direct",
        evidence: "provider-config",
        authorization: "declared",
      });
      return "direct credential reply";
    });
    const canFallbackAfterError = vi.fn(() => false);
    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-5.5",
      run,
      canFallbackAfterError,
    });
    expect(result.result).toBe("direct credential reply");
    expect(run).toHaveBeenCalledExactlyOnceWith("openai", "gpt-5.5", expect.any(Object));
    expect(canFallbackAfterError).not.toHaveBeenCalled();
  });

  it("does not mistake a wrapped quota cleanup failure for settled provider auth", async () => {
    const cause = new AggregateError([new Error("invalid_grant"), new Error("cleanup failed")]);
    const inner = new OAuthRefreshFailureError({
      provider: "openai",
      message: "OAuth refresh failed",
      cause,
      status: 401,
      reason: "invalid_grant",
    });
    const error = new OAuthRefreshFailureError({
      provider: "openai",
      message: inner.message,
      cause: inner,
    });
    authRuntimeMock.runtime.maybeReprobeWhamBlockedProfiles.mockRejectedValueOnce(error);
    const run = vi.fn();
    await expect(runWithModelFallback({ ...fallbackOptions, run })).rejects.toBe(error);
    expect(run).not.toHaveBeenCalled();
  });
});
