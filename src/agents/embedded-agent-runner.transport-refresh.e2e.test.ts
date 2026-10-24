// Keep the publication fixture installed before importing runtime consumers.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { installScriptedRunnerMocks } from "./embedded-agent-runner.mock-test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import { model as modelDefinition } from "./model-catalog-fixtures.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const fixture = usePreparedModelRuntimeHarness({ label: "transport-refresh" });
const oldUrl = "http://127.0.0.1:21431/v1";
const currentUrl = "http://127.0.0.1:21432/v1";
const remoteUrl = "https://model.example/v1";
const attempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
// Load the runtime during collection, before lifecycle hook deadlines start.

installScriptedRunnerMocks({
  runEmbeddedAttempt: (params) => attempt(params),
  resolveModel: false,
  backoff: { computeBackoff: () => 0, sleepWithAbort: async () => {} },
});
// The transport and credentials must come from production preparation, not fixture answers.
vi.doUnmock("./prepared-model-runtime.js");
vi.doUnmock("./runtime-plan/prepare-auth.js");
vi.doUnmock("./runtime-plan/materialize-model.js");
// mock-isolation: Publication uses the fixture registry without loading installed plugins.
vi.doMock("./runtime-plugins.js", () => ({
  acquireAgentRuntimePluginRegistry: async () => {
    const registry = fixture.mocks.loadAgentRuntimePluginRegistryHandle();
    return { registry, primaryRegistry: registry };
  },
  loadAgentRuntimePluginRegistryHandle: () => fixture.mocks.loadAgentRuntimePluginRegistryHandle(),
}));
const { ModelRegistry } = await import("./sessions/model-registry.js");
const { runEmbeddedAgent } = await import("./embedded-agent-runner/run.js");
const preparedModelRuntime = await import("./prepared-model-runtime.js");
const { refreshPreparedModelRuntimeSnapshots } = preparedModelRuntime;
const { log } = await import("./embedded-agent-runner/logger.js");
const { prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js");
const { setRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
beforeEach(() => {
  attempt.mockReset();
  fixture.mocks.configuredAgentIds = ["test"];
  fixture.mocks.configuredWorkspaces.set("test", fixture.state.workspaceDir);
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.modelRegistry.fork.mockImplementation((authStorage) =>
    ModelRegistry.inMemory(authStorage),
  );
});

function config(
  current = false,
  options: {
    baseUrl?: string;
    noAuth?: boolean;
    limits?: { contextWindow: number; maxTokens: number };
  } = {},
) {
  const epoch = current ? "current" : "old";
  return {
    agents: {
      defaults: { workspace: fixture.state.workspaceDir, model: "local-fixture/chat" },
      entries: { test: { workspace: fixture.state.workspaceDir } },
    },
    models: {
      providers: {
        "local-fixture": {
          api: "openai-completions",
          baseUrl: options.baseUrl ?? (current ? currentUrl : oldUrl),
          ...(!options.noAuth ? { apiKey: `synthetic-${epoch}-key` } : {}),
          headers: { "X-Local-Route": `${epoch}-route` },
          models: [
            modelDefinition(
              "chat",
              "Fixture chat",
              options.limits ?? {
                contextWindow: 16_000,
                maxTokens: 2048,
              },
            ),
          ],
        },
      },
    },
    skills: { load: { watch: false } },
  } satisfies OpenClawConfig;
}

async function publish(cfg: OpenClawConfig) {
  setRuntimeConfigSnapshot(cfg);
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

function success(sessionId: string) {
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: ["recovered"],
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: "local-fixture",
      model: "chat",
      content: [{ type: "text", text: "recovered" }],
    }),
  });
}

function failure(sessionId: string, serverError = false) {
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    terminal: {
      kind: "failed",
      source: "prompt",
      error: serverError
        ? Object.assign(new Error("500 Internal Server Error"), { status: 500 })
        : Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    },
  });
}

type TransportCase = {
  label: string;
  credentialWithdrawn?: boolean;
  assistantFailure?: boolean;
  localNoAuth?: boolean;
  initialNoAuth?: boolean;
  remote?: boolean;
  serverError?: boolean;
};

async function run(cfg: OpenClawConfig, runId: string) {
  const admission = prepareSystemAgentRunAdmission(cfg, runId, "test", "transport-refresh-fixture");
  try {
    return await runEmbeddedAgent({
      preparedRunAdmission: admission,
      agentId: "test",
      runId,
      sessionId: runId,
      sessionKey: `agent:test:${runId}`,
      sessionTarget: {
        agentId: "test",
        sessionId: runId,
        sessionKey: `agent:test:${runId}`,
        storePath: fixture.state.statePath("agents", "test", "agent", "openclaw-agent.sqlite"),
      },
      workspaceDir: fixture.state.workspaceDir,
      agentDir: fixture.state.agentDir("test"),
      config: cfg,
      provider: "local-fixture",
      model: "chat",
      prompt: "Preserve this admitted request exactly.",
      disableTools: true,
      timeoutMs: 5000,
      enqueue: immediateEnqueue,
    });
  } finally {
    admission.close();
  }
}

it.each(["rejecting release", "hung release", "rejecting discard"] as const)(
  "preserves the successful turn after %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "100");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const disposalStarted = createDeferredCore();
    const disposalFinished = createDeferredCore();
    const acquire = preparedModelRuntime.acquirePreparedModelRuntimeSnapshot;
    const acquireSpy = vi
      .spyOn(preparedModelRuntime, "acquirePreparedModelRuntimeSnapshot")
      .mockImplementation(async (...args) => {
        const lease = await acquire(...args);
        return {
          ...lease,
          [Symbol.asyncDispose]: async () => {
            await lease[Symbol.asyncDispose]();
            disposalStarted.resolve();
            if (scenario === "hung release") {
              await disposalFinished.promise;
            } else {
              throw new Error("fixture lease disposal failed");
            }
          },
        };
      });
    try {
      const initial = config();
      const discard = scenario === "rejecting discard";
      const current = config(true, {
        baseUrl: discard ? remoteUrl : currentUrl,
        noAuth: discard,
      });
      await publish(initial);
      attempt.mockImplementationOnce(async (params) => {
        await publish(current);
        return failure(params.sessionId);
      });
      attempt.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({
          model: { baseUrl: discard ? oldUrl : currentUrl },
          resolvedApiKey: discard ? "synthetic-old-key" : "synthetic-current-key",
        });
        return success(params.sessionId);
      });
      const result = run(initial, `cleanup-${scenario.replaceAll(" ", "-")}`);
      const settled = vi.fn();
      void result.then(settled, settled);
      const assertion = expect(result).resolves.toMatchObject({
        payloads: [{ text: "recovered" }],
      });
      await disposalStarted.promise;
      if (scenario === "hung release") {
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await assertion;
      expect((await result).meta.error).toBeUndefined();
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          scenario === "hung release" ? "agent cleanup timed out" : "fixture lease disposal failed",
        ),
      );
    } finally {
      disposalFinished.resolve();
      acquireSpy.mockRestore();
      warn.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  },
);

it.each<TransportCase>([
  { label: "changed origin" },
  { label: "unchanged origin", assistantFailure: true },
  { label: "local no-auth transport", credentialWithdrawn: true, localNoAuth: true },
  {
    label: "initial local no-auth transport",
    credentialWithdrawn: true,
    localNoAuth: true,
    initialNoAuth: true,
  },
  { label: "unavailable remote credential", credentialWithdrawn: true, remote: true },
  { label: "server-error", serverError: true },
])(
  "keeps credentials and endpoint coherent after a $label publication",
  async ({
    label,
    credentialWithdrawn = false,
    assistantFailure = false,
    localNoAuth = false,
    initialNoAuth = false,
    remote = false,
    serverError = false,
  }) => {
    const before = oldUrl;
    const after = remote ? remoteUrl : assistantFailure ? before : currentUrl;
    const initial = config(false, { noAuth: initialNoAuth });
    const current = config(true, {
      baseUrl: after,
      noAuth: credentialWithdrawn,
      ...(serverError ? {} : { limits: { contextWindow: 32_000, maxTokens: 4096 } }),
    });
    if (!serverError) {
      current.agents.defaults.model = "local-fixture/unrelated-model";
    }
    await publish(initial);
    const history = [
      { role: "user" as const, content: "Original recorded request.", timestamp: 1 },
    ];
    const observations: EmbeddedRunAttemptParams[] = [];
    attempt.mockImplementation(async (params) => {
      // Run disposal clears continuation payloads; record their dispatch-time facts.
      observations.push({
        ...params,
        continuation: params.continuation && {
          prompt: params.continuation.prompt,
          messages: [...params.continuation.messages],
        },
      });
      if (observations.length === 1) {
        if (!serverError) {
          expect(params).toMatchObject({
            model: { baseUrl: before, headers: { "X-Local-Route": "old-route" } },
            resolvedApiKey: initialNoAuth ? CUSTOM_LOCAL_AUTH_MARKER : "synthetic-old-key",
            prompt: "Preserve this admitted request exactly.",
          });
        }
        await publish(current);
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          messagesSnapshot: serverError ? [] : history,
          terminal: assistantFailure
            ? { kind: "ok" }
            : failure(params.sessionId, serverError).terminal,
          // The SDK can retain the connection class only in a diagnostic, without an error code.
          lastAssistant: assistantFailure
            ? buildEmbeddedRunnerAssistant({
                api: "openai-completions",
                provider: "local-fixture",
                model: "chat",
                stopReason: "error",
                errorMessage: "Connection error.",
                diagnostics: [
                  {
                    type: "provider_transport_failure",
                    timestamp: 1,
                    error: { message: "Connection error." },
                    details: { eventsEmitted: false, phase: "before_message_stream_start" },
                  },
                ],
              })
            : undefined,
        });
      }
      return success(params.sessionId);
    });

    const runId = serverError ? "server-error" : `connection-${label.replaceAll(" ", "-")}`;
    const result = await run(initial, runId);

    expect(result.payloads?.[0]?.text).toBe("recovered");
    expect(observations).toHaveLength(2);
    const first = observations[0]!;
    const retry = observations[1]!;
    if (serverError) {
      expect(retry).toMatchObject({
        model: { baseUrl: oldUrl, headers: { "X-Local-Route": "old-route" } },
        resolvedApiKey: "synthetic-old-key",
      });
      expect(retry.config).toBe(initial);
      return;
    }
    expect(retry).toMatchObject({
      provider: "local-fixture",
      modelId: "chat",
      resolvedApiKey: localNoAuth
        ? CUSTOM_LOCAL_AUTH_MARKER
        : credentialWithdrawn
          ? "synthetic-old-key"
          : "synthetic-current-key",
      model: {
        baseUrl: credentialWithdrawn && !localNoAuth ? before : after,
        contextWindow: 16_000,
        maxTokens: 2048,
        headers: {
          "X-Local-Route": credentialWithdrawn && !localNoAuth ? "old-route" : "current-route",
          ...(localNoAuth ? { Authorization: null } : {}),
        },
      },
      continuation: { prompt: "Preserve this admitted request exactly.", messages: history },
    });
    expect(first.admittedRunContext).toBeDefined();
    expect(retry.admittedRunContext).toBe(first.admittedRunContext);
    expect(retry.config).toBe(initial);
    expect(retry.sessionTarget).toMatchObject({
      agentId: "test",
      sessionId: runId,
      sessionKey: `agent:test:${runId}`,
    });
  },
);
