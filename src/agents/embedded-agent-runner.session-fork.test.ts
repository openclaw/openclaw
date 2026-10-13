import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCommittedSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { stagePlacementWorkspaceJournalWorkerPublication } from "../gateway/worker-environments/placement-turn-authority.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { readBtwTranscriptMessages, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { runBtwSideQuestion } from "./btw.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import * as sessionPlacementAdmission from "./session-placement-admission.js";

type Api = "openai-completions" | "openai-responses" | "anthropic-messages";
function response(api: Api, model: string, tool: boolean): Response {
  if (api === "openai-responses") {
    const item = tool
      ? {
          type: "function_call",
          id: "fc_fork",
          call_id: "call_fork",
          name: "fork_probe",
          arguments: "{}",
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_fork",
          role: "assistant",
          content: [{ type: "output_text", text: "Review answer", annotations: [] }],
          status: "completed",
        };
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: tool ? { ...item, arguments: "" } : { ...item, content: [] },
      },
      ...(tool
        ? [{ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }]
        : []),
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_fork",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 1000,
            output_tokens: 2,
            total_tokens: 1002,
            input_tokens_details: { cached_tokens: 900 },
          },
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const events: Array<Record<string, unknown>> =
    api === "anthropic-messages"
      ? [
          {
            type: "message_start",
            message: {
              id: "msg_fork",
              type: "message",
              role: "assistant",
              model,
              content: [],
              usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 900 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: tool
              ? { type: "tool_use", id: "toolu_fork", name: "fork_probe", input: {} }
              : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: tool
              ? { type: "input_json_delta", partial_json: "{}" }
              : { type: "text_delta", text: "Review answer" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: tool ? "tool_use" : "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]
      : [
          {
            id: "chatcmpl_fork",
            object: "chat.completion.chunk",
            model,
            choices: [
              {
                index: 0,
                delta: tool
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_fork",
                          type: "function",
                          function: { name: "fork_probe", arguments: "{}" },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Review answer" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl_fork",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 2,
              total_tokens: 1002,
              prompt_tokens_details: { cached_tokens: 900 },
            },
          },
        ];
  return new Response(
    events
      .map(
        (event) =>
          `${api === "anthropic-messages" ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + (api === "openai-completions" ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(async () => {
  cleanupSessionResources();
  await clearActivePluginRegistry();
});

describe("embedded cache-parity session fork", () => {
  it.each([
    { api: "openai-completions" as const, provider: "openai", model: "gpt-4o" },
    { api: "openai-responses" as const, provider: "openai", model: "gpt-5.5" },
    { api: "anthropic-messages" as const, provider: "anthropic", model: "claude-sonnet-4-6" },
  ])(
    "replays real $api bytes during pending placement publications and revokes on reset",
    { timeout: 120_000 },
    async ({ api, provider, model }) => {
      await withOpenClawTestState({ label: `session-fork-${provider}` }, async (state) => {
        const pluginDir = state.path("fork-plugin");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "fork-proof",
            activation: { onStartup: true },
            contracts: { tools: ["fork_probe"] },
            configSchema: { type: "object", properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `module.exports = { id: "fork-proof", register(api) { api.registerTool({ name: "fork_probe", label: "Probe", description: "Must never execute in a review", parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("FORK TOOL EXECUTED"); } }); api.on("before_prompt_build", () => ({ prependContext: "Stable plugin context" })); } };`,
        );
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              skipBootstrap: true,
              models: {
                [`${provider}/${model}`]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", cacheRetention: "short" },
                },
              },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider]: {
                api,
                baseUrl:
                  provider === "anthropic"
                    ? "https://api.anthropic.com"
                    : "https://api.openai.com/v1",
                apiKey: "synthetic-fork-key",
                models: [
                  {
                    id: model,
                    name: model,
                    api,
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: {
            allow: [provider, "fork-proof"],
            load: { paths: [pluginDir] },
            slots: { memory: "none" },
            entries: { "fork-proof": { enabled: true, hooks: { allowConversationAccess: true } } },
          },
          skills: { load: { watch: false } },
          tools: {
            allow: ["fork_probe", ...(api === "openai-responses" ? ["web_search"] : [])],
            toolSearch: false,
          },
        };
        await state.writeConfig(config);
        await captureRuntimeConfigAsyncReader()();
        await loadAndActivateRootPluginRegistry({
          config,
          workspaceDir: state.workspaceDir,
          throwOnLoadError: true,
        });
        const sessionId = `fork-${provider}`;
        const sessionKey = `agent:main:direct:${sessionId}`;
        const target = {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const host = getAiTransportHost();
        const payloads: Array<Record<string, unknown>> = [];
        let toolsRemaining = 0;
        let beforeProviderResponse: (() => void) | undefined;
        configureAiTransportHost({
          ...host,
          buildModelFetch: () => async (input, init) => {
            const payload: unknown = await new Request(input, init).json();
            if (!isRecord(payload)) {
              throw new Error("Expected a provider request object");
            }
            payloads.push(payload);
            const tool = toolsRemaining > 0;
            toolsRemaining--;
            beforeProviderResponse?.();
            return response(api, model, tool);
          },
        });
        const onUsage = vi.fn();
        const onBlockReply = vi.fn();
        const fork = (abortSignal?: AbortSignal, denyTools = true) =>
          runBtwSideQuestion({
            cfg: config,
            agentId: "main",
            agentDir: state.agentDir(),
            provider,
            model,
            question: "Review only",
            toolCalls: denyTools ? "deny" : undefined,
            onUsage,
            sessionEntry: { sessionId, updatedAt: 1 },
            sessionKey,
            storePath: target.storePath,
            isNewSession: false,
            resolvedReasoningLevel: "off",
            opts: { onBlockReply, abortSignal },
          });
        try {
          await expect(fork()).rejects.toThrow("requires a parent turn");
          expect(payloads).toHaveLength(0);
          const admission = prepareSystemAgentRunAdmission(
            config,
            "fork-parent",
            "main",
            "fork-proof",
          );
          try {
            const parent = await runEmbeddedAgent({
              preparedRunAdmission: admission,
              userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
                target: { ...target, sessionEntry: undefined },
                input: {
                  text: "Parent question",
                  timestamp: 1,
                  idempotencyKey: "fork-parent:user",
                },
              }),
              agentId: "main",
              sessionId,
              sessionKey,
              sessionTarget: target,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              config,
              provider,
              model,
              agentHarnessRuntimeOverride: "openclaw",
              modelSelectionLocked: true,
              codeModeOverride: false,
              thinkLevel: "off",
              toolsAllow: config.tools?.allow,
              runId: "fork-parent",
              timeoutMs: 60_000,
              prompt: "Parent question",
              transcriptPrompt: "Parent question",
              skillsSnapshot: {
                prompt: "<available_skills>stable skill context</available_skills>",
                skills: [],
              },
              extraSystemPrompt: "Stable parent system instructions",
            });
            expect(parent.meta.aborted).not.toBe(true);
            expect(parent.meta.error, JSON.stringify(parent)).toBeUndefined();
          } finally {
            admission.close();
          }
          expect(payloads).toHaveLength(1);
          const original = structuredClone(payloads[0]!);
          const sessionFile = resolveBtwSessionTranscriptPath({
            sessionId,
            sessionKey,
            storePath: target.storePath,
            sessionEntry: { sessionId, updatedAt: 1 },
          });
          if (!sessionFile) {
            throw new Error("Parent transcript was not created");
          }
          const readTranscript = () =>
            readBtwTranscriptMessages({
              agentId: "main",
              sessionFile,
              sessionId,
              sessionKey,
              storePath: target.storePath,
            });
          const parentTranscript = await readTranscript();
          const database = openOpenClawStateDatabase();
          const placements = createWorkerSessionPlacementStore({ database });
          const placement = await placements.prepareSessionPlacement(sessionId);
          const prepareSandbox = vi
            .spyOn(sessionPlacementAdmission, "prepareSessionPlacementSandbox")
            .mockResolvedValue({
              sandbox: null,
              assertCurrent: () => {
                placement.current();
              },
              [Symbol.dispose]: () => placement.release(),
            });
          const currentPlacement = placement.current();
          const publication = stagePlacementWorkspaceJournalWorkerPublication(
            requireOpenClawStateDatabaseIdentity({ db: database.db }),
            sessionId,
            true,
          );
          try {
            expect(placement.current()).toEqual(currentPlacement);
            await expect(fork()).resolves.toEqual({ text: "Review answer" });
            expect(prepareSandbox).not.toHaveBeenCalled();
            expect(placement.current()).toEqual(currentPlacement);
          } finally {
            publication.rollback();
            placement.release();
            prepareSandbox.mockRestore();
          }
          const replay = payloads[1]!;
          const messageKey = api === "openai-responses" ? "input" : "messages";
          const originalMessages = original[messageKey];
          const replayMessages = replay[messageKey];
          if (!Array.isArray(originalMessages) || !Array.isArray(replayMessages)) {
            throw new Error("Missing captured messages");
          }
          expect(JSON.stringify(replayMessages.slice(0, originalMessages.length))).toBe(
            JSON.stringify(originalMessages),
          );
          expect(replayMessages).toHaveLength(originalMessages.length + 1);
          expect(JSON.stringify(replayMessages.at(-1))).toContain("Review only");
          expect(JSON.stringify(replay.tools)).toBe(JSON.stringify(original.tools));
          expect(replay.tool_choice).toEqual(
            api === "anthropic-messages" ? { type: "none" } : "none",
          );
          if (api === "openai-responses") {
            expect(original.tools).toEqual(expect.arrayContaining([{ type: "web_search" }]));
          }
          expect(JSON.stringify(original.tools)).toContain("fork_probe");
          expect(JSON.stringify(replay.system)).toBe(JSON.stringify(original.system));
          expect(JSON.stringify(replay.instructions)).toBe(JSON.stringify(original.instructions));
          expect(replay.previous_response_id).toBeUndefined();
          expect(replay.prompt_cache_key).toBe(original.prompt_cache_key);
          if (api !== "anthropic-messages") {
            expect(original.prompt_cache_key).toBeTruthy();
          } else {
            expect(JSON.stringify(original)).toContain("cache_control");
          }
          expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ cacheRead: 900 }));
          expect(onBlockReply).not.toHaveBeenCalled();
          if (api === "openai-responses") {
            await expect(fork(undefined, false)).resolves.toEqual({ text: "Review answer" });
          }
          toolsRemaining = 1;
          await expect(fork()).resolves.toEqual({ text: "Review answer" });
          expect(JSON.stringify(payloads.at(-1))).toContain("Tool execution denied");
          expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ cacheRead: 1800 }));
          toolsRemaining = 3;
          const beforeDenied = payloads.length;
          await expect(fork()).rejects.toThrow("after three attempts");
          expect(payloads.length - beforeDenied).toBe(3);
          expect(await readTranscript()).toEqual(parentTranscript);
          const pluginAbort = new AbortController();
          beforeProviderResponse = () => pluginAbort.abort(new Error("plugin runtime retired"));
          await expect(fork(pluginAbort.signal)).rejects.toThrow();
          const onResetError = vi.fn();
          beforeProviderResponse = () =>
            clearCommittedSessionResetRuntimeState({
              previousSessionEntry: { sessionId },
              agentId: "main",
              sessionKey,
              onError: onResetError,
            });
          await expect(fork()).rejects.toThrow("requires a parent turn");
          expect(onResetError).not.toHaveBeenCalled();
          beforeProviderResponse = undefined;
          const beforeReset = payloads.length;
          await expect(fork()).rejects.toThrow("requires a parent turn");
          expect(payloads).toHaveLength(beforeReset);
        } finally {
          configureAiTransportHost(host);
        }
      });
    },
  );
});
