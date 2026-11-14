import assert from "node:assert/strict";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { stableStringify } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
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
import { writeTempPlugin } from "./test-helpers/temp-plugin-extension-fixtures.js";

function responseMessage(id: string, text: string) {
  const content = [{ type: "output_text", text, annotations: [] }];
  return { type: "message", id, role: "assistant", status: "completed", content };
}

it("preserves signed empty Responses messages before reasoning across a cold runner reopen", async () => {
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
    const requests: Array<Record<string, unknown>> = [];
    const prefixes: ReturnType<typeof snapshotProviderPrefix>[] = [];
    const history = new Map<string, unknown[]>();
    let turnRequests = 0;
    configureAiTransportHost({
      ...host,
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
            encrypted_content: "encrypted_" + id,
          },
          ++turnRequests < 3
            ? {
                type: "function_call",
                id: "fc_" + id,
                call_id: "call_" + id,
                name: "cache_probe",
                arguments: "{}",
              }
            : responseMessage("msg_" + id, "synthetic answer"),
        ];
        // A provider-owned empty message precedes encrypted reasoning in the last warm turn.
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
      for (let turn = 1; turn <= 2; turn++) {
        turnRequests = 0;
        if (turn === 2) {
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
        const recorder = createUserTurnTranscriptRecorder({
          target: { ...sessionTarget, sessionEntry: undefined },
          input: { text: "visible turn " + turn, timestamp: turn, idempotencyKey: runId + ":user" },
        });
        try {
          const result = await runEmbeddedAgent({
            userTurnTranscriptRecorder: recorder,
            preparedRunAdmission: admission,
            agentId: "main",
            sessionId,
            sessionKey,
            sessionTarget,
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
          expect(result.meta.error).toBeUndefined();
          expect(requests).toHaveLength(turn * 3);
        } finally {
          admission.close();
        }
      }
      expect(requests[1]?.previous_response_id).toBe("response_1");
      expect(requests[3]?.previous_response_id).toBeUndefined();
      for (let index = 1; index < prefixes.length; index++) {
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
}, 120000);
