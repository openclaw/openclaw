import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { scheduleReplySessionMaintenance } from "../../auto-reply/reply/agent-runner-maintenance.js";
import type { AccountedAgentTurn } from "../../auto-reply/reply/agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "../../auto-reply/reply/agent-runner-result.types.js";
import { runReplyAgent } from "../../auto-reply/reply/agent-runner.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { clearPendingFinalDeliveryAfterSuccess } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import {
  resolveCompactionThreshold,
  resolveResponsesServerCompactionThreshold,
} from "../../auto-reply/reply/memory-flush.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { clearMemoryPluginState } from "../../plugins/memory-state.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { resolveEffectiveCompactionReserveTokens } from "../agent-compaction-constants.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../agent-runtime-id.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { waitForSessionMaintenance } from "./coordinator.js";

const TEST_CONTEXT_WINDOW_TOKENS = 32_768;

type ModelRequest = Record<string, unknown>;

type Scenario = Awaited<ReturnType<typeof createScenario>>;

async function createProviderFixture() {
  const requests: ModelRequest[] = [];
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push(JSON.parse(body) as ModelRequest);
          const text =
            requests.length === 1
              ? "FOREGROUND_READY"
              : [
                  "## Decisions",
                  "Keep the completed answer and the archived facts.",
                  "## Open TODOs",
                  "None.",
                  "## Constraints/Rules",
                  "Preserve the active session.",
                  "## Pending user asks",
                  "None.",
                  "## Exact identifiers",
                  "maintenance-final-effect",
                ].join("\n");
          const promptTokens = 2_000;
          response.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "close",
          });
          response.write(
            `data: ${JSON.stringify({ id: "maintenance-provider", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ id: "maintenance-provider", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 50, total_tokens: promptTokens + 50 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      }),
  });
  return {
    port: reservation.claim.port,
    requests,
    async close() {
      reservation.listener.closeAllConnections();
      await reservation.releaseListener();
      await reservation.claim.release();
    },
  };
}

const AUTHORITY_PROBE_PLUGIN_ID = "maintenance-authority-probe";
const AUTHORITY_PROBE_TOOL_NAME = "maintenance_authority_probe";
const AUTHORITY_PROBE_ACTIVATION_KEY = Symbol.for(
  "openclaw.test.maintenance-authority-probe.activations",
);
const AUTHORITY_PROBE_OBSERVER_KEY = Symbol.for(
  "openclaw.test.maintenance-authority-probe.observer",
);
const AUTHORITY_PROBE_OBSERVATIONS_KEY = Symbol.for(
  "openclaw.test.maintenance-authority-probe.observations",
);

async function writeAuthorityProbePlugin(state: OpenClawTestState) {
  const relativeDir = path.join("test-plugins", AUTHORITY_PROBE_PLUGIN_ID);
  const pluginDir = state.statePath(relativeDir);
  await state.writeText(
    path.join(relativeDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: AUTHORITY_PROBE_PLUGIN_ID,
      name: "Maintenance authority probe",
      contracts: { tools: [AUTHORITY_PROBE_TOOL_NAME] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await state.writeText(
    path.join(relativeDir, "package.json"),
    JSON.stringify({
      name: "@openclaw-test/maintenance-authority-probe",
      version: "1.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await state.writeText(
    path.join(relativeDir, "index.cjs"),
    `const activationKey = Symbol.for("openclaw.test.maintenance-authority-probe.activations");
const observerKey = Symbol.for("openclaw.test.maintenance-authority-probe.observer");
const observationsKey = Symbol.for("openclaw.test.maintenance-authority-probe.observations");
module.exports = {
  id: "maintenance-authority-probe",
  name: "Maintenance authority probe",
  register(api) {
    api.on("before_compaction", () => {
      const observer = globalThis[observerKey];
      const observation = typeof observer === "function" ? observer() : "observer-missing";
      globalThis[observationsKey] = [...(globalThis[observationsKey] ?? []), observation];
    });
    api.registerTool(() => {
      globalThis[activationKey] = (globalThis[activationKey] ?? 0) + 1;
      return {
        name: "maintenance_authority_probe",
        label: "Maintenance authority probe",
        description: "Exercises real plugin-tool activation without invoking a side effect.",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "unused" }], details: {} };
        },
      };
    }, { name: "maintenance_authority_probe" });
  },
};
`,
  );
  const globals = globalThis as typeof globalThis & {
    [AUTHORITY_PROBE_ACTIVATION_KEY]?: number;
    [AUTHORITY_PROBE_OBSERVER_KEY]?: () => "present" | "absent";
    [AUTHORITY_PROBE_OBSERVATIONS_KEY]?: string[];
  };
  globals[AUTHORITY_PROBE_ACTIVATION_KEY] = 0;
  globals[AUTHORITY_PROBE_OBSERVER_KEY] = () =>
    getGatewayToolCallerIdentity() === undefined ? "absent" : "present";
  globals[AUTHORITY_PROBE_OBSERVATIONS_KEY] = [];
  return {
    pluginDir,
    getActivationCount: () => globals[AUTHORITY_PROBE_ACTIVATION_KEY] ?? 0,
    getAuthorityObservations: () => [...(globals[AUTHORITY_PROBE_OBSERVATIONS_KEY] ?? [])],
  };
}

function createConfig(params: {
  workspaceDir: string;
  storePath: string;
  port: number;
  pluginDir: string;
}) {
  return {
    agents: {
      entries: { main: { workspace: params.workspaceDir } },
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "test-provider/test-model" },
      },
    },
    session: { store: params.storePath },
    plugins: {
      enabled: true,
      allow: ["maintenance-authority-probe"],
      entries: { "maintenance-authority-probe": { enabled: true } },
      load: { paths: [params.pluginDir] },
    },
    tools: {
      profile: "coding",
      alsoAllow: [AUTHORITY_PROBE_TOOL_NAME],
      toolSearch: false,
    },
    models: {
      providers: {
        "test-provider": {
          api: "openai-completions",
          apiKey: "synthe…-key",
          baseUrl: `http://127.0.0.1:${params.port}/v1`,
          models: [
            {
              id: "test-model",
              name: "Synthetic model",
              reasoning: false,
              input: ["text"],
              contextWindow: TEST_CONTEXT_WINDOW_TOKENS,
              contextTokens: TEST_CONTEXT_WINDOW_TOKENS,
              maxTokens: 8_192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
}

async function seedSession(params: {
  state: OpenClawTestState;
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  const scope = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  await replaceSessionEntry(scope, {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    totalTokens: 2_000,
    totalTokensFresh: true,
    totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
  });
  const transcript = SessionManager.open(scope, params.state.workspaceDir);
  for (let turn = 0; turn < 3; turn += 1) {
    transcript.appendMessage({
      role: "user",
      content: `Archived turn ${turn}: ${"context ".repeat(1_500)}`,
      timestamp: turn * 2 + 1,
    });
    transcript.appendMessage(
      makeAssistantMessageFixture({
        provider: "test-provider",
        api: "openai-completions",
        model: "test-model",
        content: [{ type: "text", text: `Archived answer ${turn}` }],
        stopReason: "stop",
        errorMessage: undefined,
        timestamp: turn * 2 + 2,
        usage: {
          input: 1_000,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_002,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    );
  }
  return { scope, entry: loadSessionEntry(scope)! };
}

function createFollowup(params: {
  state: OpenClawTestState;
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
}) {
  const followupRun = createTestFollowupRun({
    agentId: "main",
    agentDir: params.state.agentDir(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionKey,
    workspaceDir: params.state.workspaceDir,
    config: params.cfg,
    provider: "test-provider",
    model: "test-model",
    messageProvider: "webchat",
    thinkLevel: "off",
    timeoutMs: 30_000,
    senderIsOwner: true,
  });
  followupRun.prompt = "Complete the current turn.";
  return followupRun;
}

async function createScenario(state: OpenClawTestState, label: string) {
  const provider = await createProviderFixture();
  const sessionId = `maintenance-${label}`;
  const sessionKey = `agent:main:maintenance:${label}`;
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const authorityProbe = await writeAuthorityProbePlugin(state);
  const cfg = createConfig({
    workspaceDir: state.workspaceDir,
    storePath,
    port: provider.port,
    pluginDir: authorityProbe.pluginDir,
  });
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const registry = loadAndActivateRootPluginRegistry({
    config: cfg,
    workspaceDir: state.workspaceDir,
    env: process.env,
    cache: false,
    onlyPluginIds: [AUTHORITY_PROBE_PLUGIN_ID],
  });
  const { scope, entry } = await seedSession({
    state,
    cfg,
    sessionId,
    sessionKey,
    storePath,
  });
  return {
    state,
    provider,
    registry,
    getAuthorityProbeActivationCount: authorityProbe.getActivationCount,
    getAuthorityObservations: authorityProbe.getAuthorityObservations,
    cfg,
    sessionId,
    sessionKey,
    storePath,
    scope,
    entry,
    followupRun: createFollowup({ state, cfg, sessionId, sessionKey }),
  };
}

async function cleanupScenario(scenario: Scenario | undefined) {
  if (!scenario) {
    return;
  }
  await waitForSessionMaintenance(scenario.sessionKey);
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearMemoryPluginState();
  clearRuntimeConfigSnapshot();
  await clearActivePluginRegistry();
  await scenario.provider.close();
}

function getCompactions(events: Awaited<ReturnType<typeof loadTranscriptEvents>>) {
  return events.filter(
    (event) =>
      typeof event === "object" && event !== null && "type" in event && event.type === "compaction",
  );
}

function countCompactions(events: Awaited<ReturnType<typeof loadTranscriptEvents>>) {
  return getCompactions(events).length;
}

function scheduleSafetyCaseMaintenance(
  scenario: Scenario,
  operation: ReturnType<typeof createReplyOperation>,
) {
  const context = {
    cfg: scenario.cfg,
    execution: {
      status: "ok",
      maintenanceAuthProfile: {},
    },
    followupRun: scenario.followupRun,
    isHeartbeat: false,
    replyOperation: operation,
    runtimePolicySessionKey: scenario.sessionKey,
    sessionKey: scenario.sessionKey,
    storePath: scenario.storePath,
  } as unknown as FinalizeReplyAgentRunInput;
  const accounting = {
    autoCompactionCount: 0,
    fallbackExhausted: false,
    modelUsed: "test-model",
    preserveUserFacingSessionState: false,
    providerUsed: "test-provider",
    runResult: {
      payloads: [{ text: "completed" }],
      meta: { agentMeta: { agentHarnessId: OPENCLAW_AGENT_RUNTIME_ID } },
    },
  } as unknown as AccountedAgentTurn;
  scheduleReplySessionMaintenance({ context, accounting, sessionEntry: scenario.entry });
}

describe("scheduled session maintenance final effects", () => {
  it("compacts through the real completed-turn path after its Gateway caller retires", async () => {
    await bindSessionMcpRuntimeTestScheduler();
    await withOpenClawTestState({ label: "scheduled-compaction-final-effect" }, async (state) => {
      let scenario: Scenario | undefined;
      try {
        scenario = await createScenario(state, "completed");
        const operation = createReplyOperation({
          sessionKey: scenario.sessionKey,
          sessionId: scenario.sessionId,
          resetTriggered: false,
        });
        operation.setPhase("running");
        let completedTurnTokens: number | undefined;
        let foregroundProbeActivations: number | undefined;
        const caller = {
          agentId: "main",
          sessionKey: scenario.sessionKey,
          operationalRunInstance: createOperationalRunInstanceRef("completed-turn"),
          receiptAuthority: () => operation.result === null,
        };
        const result = await withGatewayToolCallerIdentity(caller, async () => {
          const completed = await runReplyAgent({
            commandBody: scenario!.followupRun.prompt,
            followupRun: scenario!.followupRun,
            queueKey: scenario!.sessionKey,
            resolvedQueue: { mode: "interrupt" },
            shouldSteer: false,
            shouldFollowup: false,
            isActive: false,
            opts: { runId: "completed-turn" },
            typing: createTypingController({}),
            sessionCtx: {
              Provider: "webchat",
              MessageSid: "completed-turn",
              SessionKey: scenario!.sessionKey,
            },
            sessionEntry: scenario!.entry,
            sessionStore: { [scenario!.sessionKey]: scenario!.entry },
            sessionKey: scenario!.sessionKey,
            storePath: scenario!.storePath,
            defaultModel: "test-model",
            resolvedVerboseLevel: "off",
            isNewSession: false,
            blockStreamingEnabled: false,
            resolvedBlockStreamingBreak: "message_end",
            shouldInjectGroupIntro: false,
            typingMode: "never",
            replyOperation: operation,
          });
          if (!completed || Array.isArray(completed)) {
            throw new Error("expected one completed foreground reply");
          }
          const delivery = getReplyPayloadMetadata(completed)?.pendingFinalDeliveryCompletion;
          if (!delivery) {
            throw new Error("foreground reply did not retain final-delivery custody");
          }
          await settlePendingFinalDelivery({ kind: "pending-final", ...delivery }, "delivered", [
            "prepared",
          ]);
          await clearPendingFinalDeliveryAfterSuccess(delivery);
          const foregroundEntry = loadSessionEntry(scenario!.scope)!;
          expect(foregroundEntry.pendingFinalDelivery).toBeUndefined();
          expect(foregroundEntry.compactionCount ?? 0).toBe(0);
          // The production finalizer already scheduled maintenance, but its process-owned work
          // cannot start until this delivered foreground operation settles. Raise the stored
          // pressure before settlement so admission must take the real compaction branch.
          scenario!.entry = {
            ...foregroundEntry,
            totalTokens: 30_000,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
            updatedAt: Date.now(),
          };
          await replaceSessionEntry(scenario!.scope, scenario!.entry);
          completedTurnTokens = scenario!.entry.totalTokens;
          foregroundProbeActivations = scenario!.getAuthorityProbeActivationCount();
          expect(caller.receiptAuthority()).toBe(true);
          expect(getGatewayToolCallerIdentity()).toMatchObject({
            agentId: "main",
            sessionKey: scenario!.sessionKey,
          });
          // Force scheduled maintenance to prepare its own tool/runtime surface instead of
          // reusing the completed foreground turn's prepared snapshot. This reproduces
          // the production failure boundary where a retired caller previously leaked
          // into compaction-time plugin tool activation.
          await resetPreparedModelRuntimeSnapshotsForTest();
          operation.complete();
          return completed;
        });

        expect(operation.result).toEqual({ kind: "completed" });
        expect(caller.receiptAuthority()).toBe(false);
        await waitForSessionMaintenance(scenario.sessionKey);

        expect(result).toMatchObject({ text: "FOREGROUND_READY" });
        const compactionThreshold = resolveCompactionThreshold({
          contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
          reserveTokensFloor: resolveEffectiveCompactionReserveTokens({
            contextTokenBudget: TEST_CONTEXT_WINDOW_TOKENS,
            reserveTokens: 20_000,
          }),
          minimumThresholdTokens: resolveResponsesServerCompactionThreshold({
            contextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
            cfg: scenario.cfg,
            provider: "test-provider",
            modelId: "test-model",
          }),
        });
        expect(completedTurnTokens).toBeGreaterThanOrEqual(compactionThreshold);
        const compactedEntry = loadSessionEntry(scenario.scope);
        expect(compactedEntry?.compactionCount ?? 0).toBeGreaterThan(0);
        expect(scenario.provider.requests.length).toBeGreaterThanOrEqual(2);
        expect(foregroundProbeActivations).toBeGreaterThan(0);
        expect(scenario.getAuthorityObservations()).toContain("absent");
        const transcriptCompactions = getCompactions(await loadTranscriptEvents(scenario.scope));
        expect(transcriptCompactions.length).toBeGreaterThan(0);
        expect(JSON.stringify(transcriptCompactions)).toContain("maintenance-final-effect");
      } finally {
        await cleanupScenario(scenario);
      }
    });
  }, 60_000);

  it.each([
    "failed-owner",
    "aborted-owner",
    "gateway-lifecycle-retired",
    "gateway-instance-retired",
    "session-replaced",
  ] as const)("blocks final effects when %s loses authority", async (mode) => {
    await withOpenClawTestState({ label: `scheduled-compaction-${mode}` }, async (state) => {
      let scenario: Scenario | undefined;
      try {
        scenario = await createScenario(state, mode);
        const operation = createReplyOperation({
          sessionKey: scenario.sessionKey,
          sessionId: scenario.sessionId,
          resetTriggered: false,
        });
        operation.setPhase("running");
        let gatewayInstanceLive = true;
        const gatewayContext = {} as GatewayRequestContext;
        await withPluginRuntimeGatewayRequestScope(
          {
            pluginRegistry: scenario.registry,
            resolveGatewayContext: () => (gatewayInstanceLive ? gatewayContext : undefined),
            isWebchatConnect: () => false,
          },
          async () => {
            scheduleSafetyCaseMaintenance(scenario!, operation);
            if (mode === "failed-owner") {
              operation.fail("run_failed", new Error("foreground failed"));
              operation.complete();
            } else if (mode === "aborted-owner") {
              expect(operation.abortByUser()).toBe(true);
              operation.complete();
            } else if (mode === "gateway-lifecycle-retired") {
              rotateAgentEventLifecycleGeneration();
              operation.complete();
            } else if (mode === "gateway-instance-retired") {
              gatewayInstanceLive = false;
              operation.complete();
            } else {
              scenario!.entry = {
                ...scenario!.entry,
                lifecycleRevision: randomUUID(),
                updatedAt: Date.now(),
              };
              await replaceSessionEntry(scenario!.scope, scenario!.entry);
              operation.complete();
            }
          },
        );
        await waitForSessionMaintenance(scenario.sessionKey);

        expect(scenario.provider.requests).toHaveLength(0);
        expect(loadSessionEntry(scenario.scope)?.compactionCount ?? 0).toBe(0);
        expect(countCompactions(await loadTranscriptEvents(scenario.scope))).toBe(0);
      } finally {
        await cleanupScenario(scenario);
      }
    });
  });
});
