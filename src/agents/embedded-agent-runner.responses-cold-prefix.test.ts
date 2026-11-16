import assert from "node:assert/strict";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { stableStringify } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { cacheRunnerConfig, omitWireFields } from "./embedded-agent-runner.wire.test-support.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import { prepareInternalSessionEffectsSession } from "./internal-session-effects.js";
import { writeTempPlugin } from "./test-helpers/temp-plugin-extension-fixtures.js";

function responseMessage(id: string, text: string) {
  const content = [{ type: "output_text", text, annotations: [] }];
  return { type: "message", id, role: "assistant", status: "completed", content };
}

it.each([
  "healthy",
  "legacy",
  "recovered",
  "snapshot-recovered",
  "failed-repair",
  "deferred",
  "deferred-internal",
] as const)(
  "preserves Responses replay across a cold runner reopen (%s)",
  async (mode) => {
    const conflictingReplay = mode !== "healthy" && mode !== "legacy";
    const deferred = mode.startsWith("deferred");
    await withOpenClawTestState({ label: "responses-cold-prefix" }, async (state) => {
      const sessionId = "responses-cold-prefix";
      const sessionKey = "agent:main:" + sessionId;
      const model = "gpt-5-cold-prefix-fixture";
      const pluginDir = state.path("plugins", "cache-proof");
      writeTempPlugin({
        dir: state.path("plugins"),
        id: "cache-proof",
        filename: "index.cjs",
        manifest: {
          activation: { onStartup: true },
          contracts: { tools: ["cache_probe"] },
        },
        body: `module.exports = { id: "cache-proof", register(api) {
      api.registerTool({ name: "cache_probe", label: "Cache probe", description: "Return a synthetic record.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "synthetic tool result" }] }) });
    }};`,
      });
      const config = cacheRunnerConfig({
        api: "openai-responses",
        provider: "openai",
        model,
        workspaceDir: state.workspaceDir,
        pluginId: "cache-proof",
        pluginDir,
        apiKey: "synthetic-proof",
        input: ["text"],
        tools: ["cache_probe"],
        modelSettings: { params: { transport: "sse", cacheRetention: "short" } },
      });
      const configuredModel = config.models?.providers?.openai?.models[0];
      assert(configuredModel);
      configuredModel.reasoning = true;
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await loadAndActivateRootPluginRegistry({
        config,
        workspaceDir: state.workspaceDir,
        throwOnLoadError: true,
      });
      const sessionTarget = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(sessionTarget, { sessionId, updatedAt: 1 });
      const host = getAiTransportHost();
      const logInfo = vi.fn();
      const requests: Array<Record<string, unknown>> = [];
      const prefixes: ReturnType<typeof snapshotProviderPrefix>[] = [];
      const history = new Map<string, unknown[]>();
      let turnRequests = 0;
      let conflicts = 0;
      configureAiTransportHost({
        ...host,
        logInfo,
        buildModelFetch: () => async (input, init) => {
          const payload = (await new Request(input, init).json()) as Record<string, unknown>;
          assert(Array.isArray(payload.input));
          const inherited =
            typeof payload.previous_response_id === "string"
              ? history.get(payload.previous_response_id)
              : [];
          assert(inherited);
          const effectiveInput = [...inherited, ...payload.input];
          requests.push(payload);
          if (
            conflictingReplay &&
            ((mode === "failed-repair" && requests.length === 5) ||
              payload.input.some((value) => {
                const item = value as Record<string, unknown>;
                return item.id === "fc_response_1";
              }))
          ) {
            conflicts++;
            if (deferred || mode === "snapshot-recovered") {
              const item = responseMessage("msg_partial", "Already started.");
              const events = [
                ...(deferred
                  ? [
                      { type: "response.output_item.added", item, output_index: 0 },
                      {
                        type: "response.output_text.delta",
                        item_id: item.id,
                        output_index: 0,
                        content_index: 0,
                        delta: "Already started.",
                      },
                    ]
                  : []),
                {
                  type: "response.failed",
                  response: {
                    id: "resp_failed",
                    status: "failed",
                    output: [item],
                    error: { code: "item_conflict", message: "Stored item content differs." },
                  },
                },
              ];
              return new Response(
                events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            return Response.json(
              { error: { code: "item_conflict", message: "Stored item content differs." } },
              { status: 400 },
            );
          }
          const comparable = effectiveInput.map((value) => {
            const item = value as Record<string, unknown>;
            return item.type === "function_call" ||
              (item.type === "message" && item.role === "assistant")
              ? omitWireFields(item, ["id", "status"])
              : item;
          });
          prefixes.push(
            snapshotProviderPrefix(
              "openai-responses",
              JSON.parse(stableStringify({ ...payload, input: comparable })),
            ),
          );
          const id = "response_" + requests.length;
          const output: Array<Record<string, unknown>> = [
            {
              type: "reasoning",
              id: "rs_" + id,
              summary: [],
            },
            ++turnRequests < 3
              ? {
                  type: "function_call",
                  id: "fc_" + id,
                  call_id: "call_" + id,
                  name: "cache_probe",
                  arguments: requests.length === 1 && mode !== "legacy" ? "{ }" : "{}",
                }
              : responseMessage("msg_" + id, "synthetic answer"),
          ];
          // A provider-owned empty message precedes saved reasoning in the last warm turn.
          if (requests.length === 1) {
            output.unshift(responseMessage("msg_empty", ""));
          }
          history.set(id, [...effectiveInput, ...output]);
          const events = [
            ...output.flatMap((item, output_index) => [
              { type: "response.output_item.added", output_index, item },
              { type: "response.output_item.done", output_index, item },
            ]),
            {
              type: "response.completed",
              response: {
                id,
                status: "completed",
                output,
                usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
              },
            },
          ];
          return new Response(
            events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      try {
        // Hook/skill refresh and warm reuse are covered by embedded-agent-runner.prompt-cache.test.ts.
        for (let turn = 1; turn <= (conflictingReplay ? 3 : 2); turn++) {
          turnRequests = 0;
          if (turn > 1) {
            clearEmbeddedSessionPromptStates([sessionId]);
            await closeOpenClawAgentDatabasesAsync(state.stateDir);
            cleanupSessionResources(sessionId);
          }
          const runId = sessionId + "-" + turn;
          const admission = prepareSystemAgentRunAdmission(
            config,
            runId,
            "main",
            "cold-prefix-proof",
          );
          const target =
            mode === "deferred-internal" && turn === 3
              ? await prepareInternalSessionEffectsSession({
                  agentId: "main",
                  runId,
                  source: sessionTarget,
                  storePath: sessionTarget.storePath,
                  cwd: state.workspaceDir,
                })
              : sessionTarget;
          const recorder = createUserTurnTranscriptRecorder({
            target: { ...target, sessionEntry: undefined },
            input: {
              text: "visible turn " + turn,
              timestamp: turn,
              idempotencyKey: runId + ":user",
            },
          });
          try {
            const run = runEmbeddedAgent({
              userTurnTranscriptRecorder: recorder,
              preparedRunAdmission: admission,
              agentId: "main",
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              sessionTarget: target,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              config,
              provider: "openai",
              model,
              agentHarnessRuntimeOverride: "openclaw",
              modelSelectionLocked: true,
              codeModeOverride: false,
              thinkLevel: "off",
              toolsAllow: ["cache_probe"],
              runId,
              timeoutMs: 60000,
              prompt: "visible turn " + turn,
            });
            if (mode === "failed-repair" && turn === 2) {
              await expect(run).rejects.toMatchObject({ code: "item_conflict" });
            } else if (deferred && turn === 2) {
              expect((await run).meta.error).toBeDefined();
            } else {
              expect((await run).meta.error).toBeUndefined();
            }
            expect(requests).toHaveLength(
              deferred
                ? [3, 4, 7][turn - 1]!
                : mode === "failed-repair"
                  ? [3, 5, 8][turn - 1]!
                  : turn * 3 + (conflictingReplay && turn > 1 ? 1 : 0),
            );
          } finally {
            admission.close();
          }
        }
        expect(requests[1]?.previous_response_id).toBe("response_1");
        expect(requests[3]?.previous_response_id).toBeUndefined();
        if (!conflictingReplay) {
          expect(requests[3]?.input).toContainEqual(
            expect.objectContaining({
              type: "function_call",
              id: "fc_response_1",
              arguments: mode === "legacy" ? "{}" : "{ }",
            }),
          );
        }
        expect(conflicts).toBe(mode === "failed-repair" ? 2 : conflictingReplay ? 1 : 0);
        if (deferred) {
          expect(logInfo).toHaveBeenCalledWith(
            "openai-transport",
            expect.stringMatching(/item_conflict_recovery .* outcome=deferred/),
            undefined,
          );
          expect(logInfo).toHaveBeenCalledWith(
            "openai-transport",
            expect.stringMatching(/item_conflict_recovery .* outcome=recovered/),
            undefined,
          );
        }
        // The repair changes only the poisoned prefix once. Later cold turns retain it.
        for (let index = conflictingReplay ? 4 : 1; index < prefixes.length; index++) {
          assertStableProviderPrefix(prefixes[index - 1]!, prefixes[index]!, {
            label: "request " + (index + 1),
          });
        }
      } finally {
        configureAiTransportHost(host);
        cleanupSessionResources(sessionId);
        clearEmbeddedSessionPromptStates([sessionId]);
        await clearActivePluginRegistry();
      }
    });
  },
  120000,
);
