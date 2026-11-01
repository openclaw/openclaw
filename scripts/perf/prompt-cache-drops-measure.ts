// Multi-turn synthetic prompt replay; no Gateway or external provider is contacted.
// node --import ./scripts/tsx.mjs scripts/perf/prompt-cache-drops-measure.ts --turns 100
// Uses the real returned-result producer, command preparation, embedded prompt
// assembly and Anthropic request serializer. A database close/reopen clears volatile prompt
// state and reloads the durable transcript (not a full Gateway restart). Forty synthetic plugin tool definitions
// change once deliberately; channel, child and cron session cohorts share a mix
// of ordinary, sessions_send success/failure, and subagent_settle turns.
// Reports prefix invalidations per 100 turns, NOT measured provider cache hits.
// The mock's 8000 -> 2000 cache counters exercise the production drop diagnostics
// on each invalidation; they are not a token-savings or billing estimate.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { createAnthropicMessagesTransportStreamFn } from "../../packages/ai/src/transports/anthropic-transport-stream.js";
import { prepareSystemAgentRunAdmission } from "../../src/agents/admitted-run-context.js";
import { buildBootstrapBudgetState } from "../../src/agents/bootstrap-budget.js";
import type { AgentCommandOpts } from "../../src/agents/command/types.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  clearPromptCacheObservations,
} from "../../src/agents/embedded-agent-runner/prompt-cache-observability.js";
import { normalizeMessagesForLlmBoundary } from "../../src/agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { prepareEmbeddedAttemptSystemPrompt } from "../../src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.js";
import { buildRuntimeContextCustomMessage } from "../../src/agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { clearEmbeddedSessionPromptStates } from "../../src/agents/embedded-agent-runner/session-prompt-state.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../src/agents/internal-runtime-context.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { SessionManager } from "../../src/agents/sessions/session-manager.js";
import { runSessionsSendA2AFlow } from "../../src/agents/tools/sessions-send-tool.a2a.js";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../src/config/sessions/session-accessor.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../../src/infra/agent-run-registry.js";
import type { Model } from "../../src/llm/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { snapshotProviderPrefix } from "../e2e/lib/anthropic-cache/prefix-stability.mts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "100" },
    owner: { type: "string" },
    capture: { type: "string" },
  },
});
const {
  prepareEmbeddedSessionState,
}: typeof import("../../src/agents/command/session-preparation.js") = await import(
  values.owner
    ? pathToFileURL(path.resolve(values.owner)).href
    : "../../src/agents/command/session-preparation.js"
);
const capturedRequests: unknown[] = [];
const turns = Number(values.turns);
assert.ok(Number.isSafeInteger(turns) && turns >= 10);
const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "Synthetic cache probe",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://provider.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 16,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const host = getAiTransportHost();
configureAiTransportHost({
  ...host,
  buildModelFetch: () => async () => {
    throw new Error("No network permitted in prompt replay");
  },
});
const stream = createAnthropicMessagesTransportStreamFn();
try {
  await withOpenClawTestState({ label: "prompt-cache-drops" }, async (state) => {
    const config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    for (const kind of ["channel", "child", "cron"] as const) {
      const sessionId = `cache-replay-${kind}`;
      const sessionKey =
        kind === "channel"
          ? "agent:main:webchat:direct:synthetic"
          : kind === "child"
            ? "agent:main:subagent:synthetic"
            : "agent:main:cron:synthetic:run:fixed";
      const target = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const sessionEntry = {
        sessionId,
        updatedAt: 1,
        chatType: "direct" as const,
        delivery: { kind: "internal" as const },
      };
      await upsertSessionEntryCore(target, sessionEntry);
      let manager = await SessionManager.openAsync(target, state.workspaceDir);
      let previous: ReturnType<typeof snapshotProviderPrefix> | undefined;
      const facts = new Map<string, number>();
      let drops = 0;
      const started = process.cpuUsage();
      for (let turn = 0; turn < turns; turn++) {
        if (turn === Math.floor(turns / 2)) {
          clearEmbeddedSessionPromptStates([sessionId]);
          await closeOpenClawAgentDatabasesAsync(state.stateDir);
          manager = await SessionManager.openAsync(target, state.workspaceDir);
        }
        const phase = turn % 5;
        const sourceTool = phase === 4 ? "subagent_settle" : "subagent_announce";
        let extraSystemPrompt: string | undefined;
        if (phase === 1 || phase === 3) {
          await runSessionsSendA2AFlow({
            targetSessionKey: "agent:main:subagent:returned",
            targetAgentId: "main",
            requesterSessionKey: sessionKey,
            displayKey: "synthetic child",
            runId: `child-${turn}`,
            replyTimeoutMs: 1000,
            replyMode: "one-way",
            notifyRequesterOnWaitFailure: true,
            reply:
              phase === 1
                ? {
                    status: "ok",
                    replyText: "Synthetic child result.",
                    terminalReply: { disposition: "visible", text: "Synthetic child result." },
                  }
                : { status: "error", error: "Synthetic failed operation." },
            deliverRequesterReply: async (reply) => {
              extraSystemPrompt = reply.extraSystemPrompt;
            },
          });
          assert.ok(extraSystemPrompt, "returned-result producer reached requester");
        }
        const runId = `${sessionId}-${turn}`;
        const opts: AgentCommandOpts = {
          message: `Synthetic turn ${turn}`,
          silentReplyPromptMode: "none",
          channel: "webchat",
          extraSystemPrompt,
          ...(phase === 1 || phase === 3 ? { replyExpectation: "optional" as const } : {}),
          ...(phase !== 0 && phase !== 2
            ? { inputProvenance: { kind: "inter_session" as const, sourceTool } }
            : {}),
        };
        const command = await prepareEmbeddedSessionState({
          cfg: config,
          opts,
          sessionEntry,
          sessionId,
          sessionKey,
          sessionAgentId: "main",
          runId,
          storePath: state.path("unused.sqlite"),
          executionWorkspaceDir: state.workspaceDir,
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          watchSkills: false,
          isNewSession: false,
          isSubagentLaneTurn: kind === "child",
          suppressVisibleSessionEffects: true,
          sessionStateActor: { actorType: "agent" },
        });
        const tools = Array.from({ length: 40 }, (_, index) => ({
          name: `synthetic_plugin_${index}`,
          label: `Synthetic ${index}`,
          description: `Synthetic plugin guidance ${index}.`,
          parameters: {
            type: "object",
            properties:
              index === 0 && turn >= Math.floor(turns * 0.75)
                ? { refreshed: { type: "boolean" } }
                : {},
          },
          execute: async () => ({ content: [] }),
        }));
        const admission = prepareSystemAgentRunAdmission(config, runId, "main", "cache-replay");
        try {
          const prepared = await prepareEmbeddedAttemptSystemPrompt({
            activeContextEngine: undefined,
            attempt: {
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              sessionId,
              sessionKey,
              runId,
              model,
              provider: model.provider,
              modelId: model.id,
              admittedRunContext: await admission.admit("embedded"),
              messageChannel: "webchat",
              silentReplyPromptMode: command.opts.silentReplyPromptMode,
              extraSystemPrompt: command.opts.extraSystemPrompt,
              extraSystemPromptTurnContext: command.opts.extraSystemPromptTurnContext,
            },
            setup: {
              effectiveCwd: state.workspaceDir,
              effectiveWorkspace: state.workspaceDir,
              proactiveSubagentOrchestration: false,
              sandbox: null,
              sandboxReport: { mode: "off", sandboxed: false },
              sandboxSessionKey: sessionKey,
              sessionAgentId: "main",
              getProviderRuntimeHandle: () => ({
                provider: model.provider,
                modelId: model.id,
                prepared: true,
              }),
            },
            referencePaths: { docsPath: null, sourcePath: null },
            bootstrap: {
              ...buildBootstrapBudgetState({ files: [] }),
              bootstrapMode: "full",
              contextFiles: [],
              bootstrapInjectionStats: [],
              shouldRecordCompletedBootstrapTurn: false,
              workspaceNotes: [],
            },
            capabilityToolNames: new Set(tools.map((tool) => tool.name)),
            effectiveTools: tools,
            isRawModelRun: false,
            modelToolsEnabled: true,
            skillsPrompt: "",
            toolSearchDirectoryEnabled: false,
            toolSearchRuntimeConfig: config,
          });
          const fragments = prepared.runtimeContextFragments ?? [];
          const carrier = buildRuntimeContextCustomMessage(
            fragments.map((fragment) => fragment.text).join("\n\n"),
            fragments,
          );
          if (carrier) {
            await manager.appendMessageAsync(carrier);
          }
          await manager.appendMessageAsync({
            role: "user",
            content: opts.message,
            timestamp: turn + 1,
          });
          const context = {
            systemPrompt: prepared.systemPromptText,
            tools,
            messages: convertToLlm(
              relocateCurrentRuntimeContextCarrierToTail(
                normalizeMessagesForLlmBoundary(manager.buildSessionContext().messages, {
                  includeTimestamp: false,
                }),
              ),
            ),
          };
          let payload: unknown;
          const response = await stream(model, context, {
            apiKey: "synthetic-unused",
            cacheRetention: "short",
            onPayload: (body) => {
              payload = body;
              throw new Error("Captured before network");
            },
          });
          await response.result();
          assert.ok(payload, "real serializer produced request");
          if (extraSystemPrompt) {
            assert.ok(
              JSON.stringify(payload).includes(JSON.stringify(extraSystemPrompt).slice(1, -1)),
              "request preserves exact returned-result guidance",
            );
          }
          if (turn < 5) {
            capturedRequests.push(payload);
          }
          const next = snapshotProviderPrefix("anthropic-messages", payload);
          assert.ok(next.breakpoints.length > 0, "Anthropic cache checkpoints present");
          const broke =
            previous &&
            (previous.system !== next.system ||
              previous.tools !== next.tools ||
              previous.history
                .slice(0, (previous.breakpoints.at(-1)?.index ?? -1) + 1)
                .some((item, index) => item !== next.history[index]));
          const observation = {
            sessionId,
            provider: model.provider,
            modelId: model.id,
            streamStrategy: "synthetic",
            systemPrompt: context.systemPrompt,
            tools: collectPromptCacheTools(tools),
            messages: context.messages,
          };
          // Warm each previous request before probing the next one so consecutive
          // invalidations are all attributed instead of hidden by a low mock counter.
          beginPromptCacheObservation(observation);
          const drop = completePromptCacheObservation({
            sessionId,
            usage: { input: 12000, cacheRead: broke ? 2000 : 8000 },
          });
          if (broke) {
            drops++;
            for (const change of drop?.changes ?? []) {
              const labels = change.detail.split("; facts: ")[1]?.split(", ") ?? [change.code];
              for (const label of labels) {
                facts.set(label, (facts.get(label) ?? 0) + 1);
              }
            }
          }
          beginPromptCacheObservation(observation);
          completePromptCacheObservation({ sessionId, usage: { input: 12000, cacheRead: 8000 } });
          previous = next;
          await manager.appendMessageAsync({
            role: "assistant",
            content: [{ type: "text", text: `Synthetic answer ${turn}` }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: turn + 1,
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          });
        } finally {
          admission.close();
          clearAgentRunContext(runId);
        }
      }
      const cpu = process.cpuUsage(started);
      console.log(
        JSON.stringify({
          kind,
          turns,
          prefixDrops: drops,
          dropsPer100Turns: (drops * 100) / turns,
          facts: Object.fromEntries([...facts].toSorted((a, b) => b[1] - a[1])),
          cpuUsPerTurn: (cpu.user + cpu.system) / turns,
          hostLoad: loadavg(),
        }),
      );
      clearPromptCacheObservations(sessionId);
    }
  });
  if (values.capture) {
    await writeFile(values.capture, JSON.stringify(capturedRequests));
  }
} finally {
  configureAiTransportHost(host);
}
