import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";

it("preserves signed empty Responses messages before reasoning across a cold runner reopen", async () => {
  await withOpenClawTestState({ label: "responses-cold-prefix" }, async (state) => {
    const sessionId = "responses-cold-prefix";
    const sessionKey = "agent:main:" + sessionId;
    const model = "gpt-5-cold-prefix-fixture";
    const instructions = "Stable replay instructions.\n".repeat(32);
    const pluginDir = state.path("cache-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cache-proof",
        activation: { onStartup: true },
        contracts: { tools: ["cache_probe"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: "cache-proof", register(api) {
      api.registerTool({ name: "cache_probe", label: "Cache probe", description: "Return a synthetic record.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "synthetic tool result" }] }) });
      api.on("before_prompt_build", (event) => ({ prependContext: "before " + event.prompt, appendContext: "after " + event.prompt }));
    }};`,
    );
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          models: {
            ["openai/" + model]: { params: { transport: "sse", cacheRetention: "short" } },
          },
          bootstrapMaxChars: instructions.length + 4096,
          bootstrapTotalMaxChars: instructions.length + 8192,
        },
      },
      models: {
        mode: "replace",
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "synthetic-proof",
            models: [
              {
                id: model,
                name: model,
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                contextWindow: 1000000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: {
        allow: ["openai", "cache-proof"],
        load: { paths: [pluginDir] },
        slots: { memory: "none" },
        entries: { "cache-proof": { enabled: true, hooks: { allowConversationAccess: true } } },
      },
      skills: { load: { watch: false } },
      tools: { allow: ["cache_probe"], toolSearch: false },
    };
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
          if (
            item.type !== "function_call" &&
            !(item.type === "message" && item.role === "assistant")
          ) {
            return item;
          }
          const { id: _id, status: _status, ...rest } = item;
          return rest;
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
            : {
                type: "message",
                id: "msg_" + id,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "synthetic answer", annotations: [] }],
              },
        ];
        // A provider-owned empty message precedes encrypted reasoning in the last warm turn.
        if (requests.length === 7) {
          output.unshift({
            type: "message",
            id: "msg_empty",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "", annotations: [] }],
          });
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
      for (let turn = 1; turn <= 4; turn++) {
        turnRequests = 0;
        await fs.writeFile(
          path.join(state.workspaceDir, "AGENTS.md"),
          instructions +
            "\n\n## Skills\nSynthetic skill " +
            (turn < 3 ? "initial" : "updated") +
            ".\n## Temporal Context\nSynthetic day " +
            (turn < 3 ? "initial" : "updated") +
            ".\n## Runtime\nSynthetic runtime " +
            (turn < 3 ? "initial" : "updated") +
            ".\n",
        );
        if (turn === 4) {
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
            skillsSnapshot: { prompt: "skills revision " + (turn < 3 ? 1 : 2), skills: [] },
            extraSystemPrompt:
              "Preserve prior instructions and answer only the latest requested marker.",
          });
          expect(result.meta.error).toBeUndefined();
          expect(requests).toHaveLength(turn * 3);
        } finally {
          admission.close();
        }
      }
      expect(requests[1]?.previous_response_id).toBe("response_1");
      expect(requests[3]?.previous_response_id).toBe("response_3");
      expect(requests[9]?.previous_response_id).toBeUndefined();
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
