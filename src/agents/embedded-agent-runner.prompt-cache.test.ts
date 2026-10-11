// End-to-end prompt reuse through the admitted runner, durable transcript and real serializers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { stableStringify } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { withinTest } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { RUNTIME_CONTEXT_HEADER } from "../llm/types.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { bindSessionMcpRuntimeTestScheduler } from "./agent-bundle-mcp-manager.test-support.js";
import { disposeAllSessionMcpRuntimes, peekSessionMcpRuntime } from "./agent-bundle-mcp-tools.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import * as promptCacheRequestObserver from "./embedded-agent-runner/prompt-cache-request-observer.js";
import { queueEmbeddedAgentMessageWithOutcomeAsync } from "./embedded-agent-runner/runs.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "./internal-runtime-context.js";
import { SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION } from "./subagents/completion/subagent-completion-instructions.js";
import { startPromptCacheMcpServer } from "./test-helpers/prompt-cache-mcp.test-support.js";

type Api = "openai-responses" | "openai-completions" | "anthropic-messages";
const cases = [
  { api: "openai-responses", provider: "openai", model: "gpt-5.5", route: "responses" },
  { api: "openai-completions", provider: "openai", model: "gpt-4o", route: "completions" },
  {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    route: "messages",
  },
  { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5", route: "in-history" },
] satisfies Array<{ api: Api; provider: string; model: string; route: string }>;
const PNG = createSolidPngBuffer(1, 1, { r: 12, g: 34, b: 56 }).toString("base64");
const FAILED_ASSISTANT_TEXT = "partial assistant output before provider error";
const FAILED_ASSISTANT_REPLAY_TEXT =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";

function responseFor(
  api: Api,
  model: string,
  request: number,
  tool: boolean,
  failure = false,
): { response: Response; output: Array<Record<string, unknown>> } {
  const id = `cache_${request}`;
  const text = `answer ${request}`;
  const calls = tool
    ? Array.from({ length: 5 }, (_, index) => ({
        id: `${api === "anthropic-messages" ? "toolu" : "call"}_${id}_${index}`,
        name: "cache_probe",
        arguments: "{}",
      }))
    : [];
  let events: Array<Record<string, unknown>>;
  let output: Array<Record<string, unknown>> = [];
  if (api === "anthropic-messages") {
    const blocks = tool
      ? calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: {} }))
      : [{ type: "text", text: "" }];
    events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          usage: { input_tokens: 1_000, output_tokens: 0 },
        },
      },
      ...blocks.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        {
          type: "content_block_delta",
          index,
          delta: tool
            ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text },
        },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
  } else if (api === "openai-completions") {
    events = [
      {
        id,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : { role: "assistant", content: text },
            finish_reason: null,
          },
        ],
      },
      {
        id,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1_000, completion_tokens: 2, total_tokens: 1_002 },
      },
    ];
  } else {
    const items: Array<Record<string, unknown>> = tool
      ? calls.map((call) => ({
          type: "function_call",
          id: `fc_${call.id}`,
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          ...(failure ? { async: true } : {}),
        }))
      : [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
            status: "completed",
            id: `msg_${id}`,
          },
        ];
    if (failure) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: FAILED_ASSISTANT_TEXT, annotations: [] }],
        status: "completed",
        id: `msg_${id}`,
      });
    }
    output = items;
    events = [
      ...items.flatMap((item, output_index) => [
        {
          type: "response.output_item.added",
          output_index,
          item:
            item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] },
        },
        ...(item.type === "function_call"
          ? [{ type: "response.function_call_arguments.delta", output_index, delta: "{}" }]
          : []),
        { type: "response.output_item.done", output_index, item },
      ]),
      {
        type: failure ? "response.failed" : "response.completed",
        response: {
          id,
          status: failure ? "failed" : "completed",
          output: items,
          ...(failure
            ? {
                error: {
                  code: "invalid_request_error",
                  message: "Synthetic terminal provider failure",
                },
              }
            : {}),
          usage: { input_tokens: 1_000, output_tokens: 2, total_tokens: 1_002 },
        },
      },
    ];
  }
  const response = new Response(
    events
      .map(
        (event) =>
          `${api === "anthropic-messages" ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + (api === "anthropic-messages" ? "" : "data: [DONE]\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  );
  return { response, output };
}

afterEach(async () => {
  await clearActivePluginRegistry();
});

describe("provider prefix across admitted Gateway agent turns", () => {
  it.for(cases)(
    "preserves $route prefixes across tool loops, hooks, images, errors, refresh and reopen",
    { timeout: 120_000 },
    async ({ api, provider, model, route }, { signal }) => {
      await withOpenClawTestState({ label: `prompt-cache-${route}` }, async (state) => {
        await bindSessionMcpRuntimeTestScheduler();
        const mcp = await startPromptCacheMcpServer(signal);
        try {
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
            `module.exports = {
        id: "cache-proof", register(api) {
          api.registerTool({ name: "cache_probe", label: "Cache probe", description: "Return a large deterministic synthetic result.", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "synthetic tool result ".repeat(5000) }] }) });
          api.on("before_prompt_build", (event) => ({ prependContext: "hook before " + event.prompt, appendContext: "hook after " + event.prompt }));
        }
      };`,
          );
          const sessionId = `cache-${route}`;
          const sessionKey = `agent:main:telegram:direct:${sessionId}`;
          const config: OpenClawConfig = {
            agents: {
              entries: { main: { workspace: state.workspaceDir } },
              defaults: {
                skipBootstrap: true,
                models: {
                  [`${provider}/${model}`]: {
                    params: { transport: "sse", openaiWsWarmup: false, cacheRetention: "short" },
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
                  apiKey: "synthetic-cache-proof",
                  models: [
                    {
                      id: model,
                      name: model,
                      api,
                      reasoning: false,
                      input: ["text", "image"],
                      contextWindow: 32_768,
                      maxTokens: 1024,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
            plugins: {
              allow: [provider, "cache-proof"],
              load: { paths: [pluginDir] },
              slots: { memory: "none" },
              entries: {
                "cache-proof": { enabled: true, hooks: { allowConversationAccess: true } },
              },
            },
            skills: { load: { watch: false } },
            channels: { telegram: { enabled: false, dmHistoryLimit: 5 } },
            tools: { allow: ["cache_probe", "cache_fixture__probe"], toolSearch: false },
            mcp: mcp.config,
          };
          await state.writeConfig(config);
          const registry = await loadAndActivateRootPluginRegistry({
            config,
            workspaceDir: state.workspaceDir,
            throwOnLoadError: true,
          });
          expect(
            registry.typedHooks.some(
              (hook) => hook.pluginId === "cache-proof" && hook.hookName === "before_prompt_build",
            ),
            "Gateway startup admitted the prompt hook",
          ).toBe(true);
          const target = {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          };
          await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
          const host = getAiTransportHost();
          const requests: Array<{
            turn: number;
            payload: unknown;
            prefix: ReturnType<typeof snapshotProviderPrefix>;
            userEnvelopes: Map<string, string>;
          }> = [];
          const responseHistory = new Map<string, unknown[]>();
          let userEnvelopes = new Map<string, string>();
          let turn = 0;
          let requestsThisTurn = 0;
          let providerFailure: Error | undefined;
          const createObserver = promptCacheRequestObserver.createPromptCacheRequestObserver;
          const observerSpy = vi
            .spyOn(promptCacheRequestObserver, "createPromptCacheRequestObserver")
            .mockImplementation((...args) => {
              const observer = createObserver(...args);
              return {
                ...observer,
                onModelRequest: (runtimeModel, context) => {
                  const occurrences = new Map<string, number>();
                  let userAnchor = "";
                  userEnvelopes = new Map(
                    context.messages.flatMap<readonly [string, string]>((message) => {
                      if (
                        message.role !== "user" ||
                        message.operatorMessage ||
                        // Legacy transient carriers intentionally refresh beyond the cache boundary.
                        (message.runtimeContextCarrier && !message.runtimeContextCarrierRetained)
                      ) {
                        return [];
                      }
                      const { content, ...envelope } = message;
                      // The wire-prefix oracle below separately protects their content.
                      const text =
                        typeof content === "string"
                          ? content
                          : content
                              .flatMap((block) => (block.type === "text" ? [block.text] : []))
                              .join("\n");
                      const textDigest = createHash("sha256").update(text).digest("hex");
                      // Match identical carriers within their preceding user position;
                      // a newly appended carrier must not replace an earlier occurrence.
                      const identity = message.runtimeContextCarrier
                        ? `${userAnchor}:${textDigest}`
                        : textDigest;
                      if (!message.runtimeContextCarrier) {
                        userAnchor = textDigest;
                      }
                      const occurrence = occurrences.get(identity) ?? 0;
                      occurrences.set(identity, occurrence + 1);
                      return [
                        [
                          `${identity}:${occurrence}`,
                          createHash("sha256").update(stableStringify(envelope)).digest("hex"),
                        ],
                      ];
                    }),
                  );
                  return observer.onModelRequest(runtimeModel, context);
                },
              };
            });
          configureAiTransportHost({
            ...host,
            buildModelFetch: () => async (input, init) => {
              try {
                const payload: unknown = await new Request(input, init).json();
                let effectivePayload = payload;
                let effectiveInput: unknown[] | undefined;
                if (api === "openai-responses") {
                  assert(payload && typeof payload === "object" && "input" in payload);
                  assert(Array.isArray(payload.input));
                  const previousId =
                    "previous_response_id" in payload ? payload.previous_response_id : undefined;
                  if (previousId !== undefined) {
                    assert.equal(typeof previousId, "string");
                    const inherited = responseHistory.get(previousId as string);
                    assert(inherited, "continuation references an existing provider response");
                    effectiveInput = [...inherited, ...payload.input];
                  } else {
                    effectiveInput = payload.input;
                  }
                  effectivePayload = { ...payload, input: effectiveInput };
                }
                const prefix = snapshotProviderPrefix(api, effectivePayload);
                if (route === "messages") {
                  const runtimeIndex = prefix.history.findIndex((item) =>
                    item.includes(RUNTIME_CONTEXT_HEADER),
                  );
                  expect(
                    prefix.breakpoints.length,
                    "legacy Messages cache boundary",
                  ).toBeGreaterThan(0);
                  const unsafeMarker = prefix.breakpoints.find(
                    (point) => runtimeIndex >= 0 && point.index >= runtimeIndex,
                  );
                  if (unsafeMarker) {
                    const digest = createHash("sha256")
                      .update(prefix.history[runtimeIndex]!)
                      .digest("hex");
                    throw new Error(
                      `messages request ${requests.length + 1}, turn ${turn}: cacheBreakpoint covers transient segment=history[${runtimeIndex}] previous=absent next=${digest} marker=${unsafeMarker.index}`,
                    );
                  }
                }
                expect(
                  prefix.tools.includes('"name":"cache_probe"'),
                  "synthetic provider only calls an advertised tool",
                ).toBe(true);
                requests.push({ turn, payload, prefix, userEnvelopes });
                requestsThisTurn++;
                if (turn === 6 && requestsThisTurn === 1) {
                  const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
                    sessionId,
                    "mid-run steering correction",
                  );
                  expect(outcome.queued, "the active runner accepted steering").toBe(true);
                }
                if (requestsThisTurn > 4) {
                  throw new Error(`Unexpected provider retry in synthetic turn ${turn}`);
                }
                const failure = api === "openai-responses" && turn === 7 && requestsThisTurn === 1;
                const result = responseFor(
                  api,
                  model,
                  requests.length,
                  (turn === 1 && requestsThisTurn === 1) || failure,
                  failure,
                );
                if (effectiveInput) {
                  // Full replay omits provider item IDs. Function calls also omit
                  // status; assistant messages retain their completed status.
                  const output = result.output.map((item) => {
                    const { id: _id, ...withoutId } = item;
                    if (item.type === "function_call") {
                      const { status: _status, ...call } = withoutId;
                      return call;
                    }
                    return withoutId;
                  });
                  responseHistory.set(`cache_${requests.length}`, [...effectiveInput, ...output]);
                }
                return result.response;
              } catch (error) {
                providerFailure = toErrorObject(error, "Mock provider request failed");
                throw error;
              }
            },
          });
          try {
            for (turn = 1; turn <= 10; turn++) {
              requestsThisTurn = 0;
              if (turn === 3) {
                const runtime = peekSessionMcpRuntime({ sessionKey });
                expect(runtime, "MCP catalog was established by a real turn").toBeDefined();
                mcp.expireSession();
                await expect(runtime!.callTool("cache_fixture", "probe", {})).rejects.toThrow(
                  "Session not found",
                );
                await runtime!.getCatalog();
                await withinTest(mcp.reconnectStarted, signal);
              }
              if (turn === 4) {
                mcp.releaseReconnect();
                await withinTest(mcp.reconnectListed, signal);
              }
              if (turn === 7) {
                // Simulate the durable runner lifecycle after Gateway restart, without a second server boot.
                clearEmbeddedSessionPromptStates([sessionId]);
                await closeOpenClawAgentDatabasesAsync(state.stateDir);
              }
              const runId = `${sessionId}-turn-${turn}`;
              const provenance =
                turn === 8
                  ? {
                      kind: "inter_session" as const,
                      sourceSessionKey: "agent:main:subagent:cache-child",
                      sourceChannel: "internal",
                      sourceTool: "subagent_announce",
                    }
                  : undefined;
              const internalEvents: AgentInternalEvent[] | undefined = provenance
                ? [
                    {
                      type: "task_completion",
                      source: "subagent",
                      childSessionKey: provenance.sourceSessionKey,
                      childSessionId: "cache-child",
                      announceType: "subagent task",
                      taskLabel: "Synthetic cache verification",
                      status: "ok",
                      statusLabel: "completed successfully",
                      result: "Synthetic child verification completed.",
                      replyInstruction: SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION,
                    },
                  ]
                : undefined;
              const transcriptPrompt = provenance
                ? RUNTIME_EVENT_USER_PROMPT
                : `visible turn ${turn}`;
              const instructionRevision =
                (route === "responses" || route === "in-history") && turn >= 4 ? 2 : 1;
              const admission = prepareSystemAgentRunAdmission(
                config,
                runId,
                "main",
                "prompt-cache-proof",
              );
              const recorder = createUserTurnTranscriptRecorder({
                target: { ...target, sessionEntry: undefined },
                input: {
                  text: transcriptPrompt,
                  provenance,
                  timestamp: turn,
                  idempotencyKey: `${runId}:user`,
                },
              });
              try {
                const result = await runEmbeddedAgent({
                  userTurnTranscriptRecorder: recorder,
                  abortSignal: signal,
                  inputProvenance: provenance,
                  internalEvents,
                  preparedRunAdmission: admission,
                  onExecutionPhase: ({ phase }) => {
                    // Responses keeps real continuation state; the other fixtures are stateless.
                    if (phase === "model_call_started" && api !== "openai-responses") {
                      cleanupSessionResources(sessionId);
                    }
                  },
                  agentId: "main",
                  sessionId,
                  sessionKey,
                  sessionTarget: {
                    agentId: "main",
                    sessionId,
                    sessionKey,
                    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
                  },
                  agentDir: state.agentDir(),
                  workspaceDir: state.workspaceDir,
                  config,
                  provider,
                  model,
                  agentHarnessRuntimeOverride: "openclaw",
                  modelSelectionLocked: true,
                  codeModeOverride: false,
                  thinkLevel: "off",
                  toolsAllow: ["cache_probe", "cache_fixture__probe"],
                  runId,
                  // The first admitted turn lazily loads the provider/plugin runtime.
                  timeoutMs: turn === 1 ? 60_000 : 20_000,
                  prompt: provenance
                    ? transcriptPrompt
                    : turn % 2 === 0
                      ? `replacement model prompt ${turn}`
                      : transcriptPrompt,
                  transcriptPrompt,
                  skillsSnapshot: {
                    prompt: `<available_skills>synthetic skill revision ${instructionRevision}</available_skills>`,
                    skills: [],
                  },
                  extraSystemPrompt: `## Temporal Context\nSynthetic day ${instructionRevision}\n## Runtime\nSynthetic revision ${instructionRevision}`,
                  ...(turn <= 2
                    ? { images: [{ type: "image" as const, mimeType: "image/png", data: PNG }] }
                    : {}),
                });
                if (providerFailure) {
                  throw providerFailure;
                }
                expect(result.meta.aborted, `turn ${turn} aborted`).not.toBe(true);
                expect(
                  requestsThisTurn,
                  `turn ${turn} reached provider ${JSON.stringify({
                    error: result.meta.error?.kind,
                    stopReason: result.meta.stopReason,
                    attempts: result.meta.executionTrace?.attempts?.map(
                      ({ result: attemptResult, stage, elapsedMs }) => ({
                        result: attemptResult,
                        stage,
                        elapsedMs,
                      }),
                    ),
                  })}`,
                ).toBeGreaterThan(0);
                if (!(api === "openai-responses" && turn === 7)) {
                  expect(
                    result.payloads?.some((payload) => payload.text?.includes("answer")),
                    `turn ${turn} completed`,
                  ).toBe(true);
                }
              } finally {
                admission.close();
              }
            }
            expect(requests.length).toBe(12);
            if (api === "openai-responses") {
              expect(requests.filter((request) => request.turn === 7)).toHaveLength(1);
              const afterFailure = requests.find((request) => request.turn === 8)!.prefix.history;
              expect(
                afterFailure.join(""),
                "next turn retains the failed assistant identity without replaying unfinished text",
              ).toContain(FAILED_ASSISTANT_REPLAY_TEXT);
              expect(afterFailure.join("")).not.toContain(FAILED_ASSISTANT_TEXT);
              const continuation = requests[1]!.payload as Record<string, unknown>;
              expect(
                continuation.previous_response_id,
                "tool results continue the first response",
              ).toBe("cache_1");
              const input = continuation.input as Array<Record<string, unknown>>;
              // The runner may append fresh runtime context alongside the tool results.
              expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(5);
              expect(input.filter((item) => item.type === "function_call")).toEqual([]);
              expect(
                continuation.prompt_cache_key,
                "tool continuations retain the session affinity key",
              ).toBe((requests[0]!.payload as Record<string, unknown>).prompt_cache_key);
            }
            expect(
              requests[0]!.userEnvelopes.size,
              "raw user envelope capture reached the request observer",
            ).toBeGreaterThan(0);
            const firstPrefix = requests[0]!.prefix.history.join("");
            expect(
              firstPrefix.includes("hook before"),
              "plugin prepend hook reached provider",
            ).toBe(true);
            expect(firstPrefix.includes("hook after"), "plugin append hook reached provider").toBe(
              true,
            );
            expect(firstPrefix.includes(PNG), "image reached provider").toBe(true);
            expect(
              requests
                .find((request) => request.turn === 2)!
                .prefix.history.join("")
                .includes("replacement model prompt 2"),
              "model-only replacement reached provider",
            ).toBe(true);
            const toolResults = requests[1]!.prefix.history.filter((segment) =>
              segment.includes("synthetic tool result"),
            );
            expect(toolResults.length).toBe(5);
            expect(
              toolResults.reduce((bytes, segment) => bytes + segment.length, 0),
              "five fresh 16k results exceed the aggregate budget; sent bytes must stay frozen",
            ).toBeGreaterThan(65_536);
            expect(
              requests
                .find((request) => request.turn === 8)!
                .prefix.history.join("")
                .includes("Synthetic child verification completed"),
              "announcement context reached provider",
            ).toBe(true);
            const recoveredMcpResult = await peekSessionMcpRuntime({ sessionKey })!.callTool(
              "cache_fixture",
              "probe",
              {},
            );
            expect(
              recoveredMcpResult.isError ?? false,
              "MCP replacement accepted a real tool call",
            ).toBe(false);
            for (let index = 1; index < requests.length; index++) {
              const previous = requests[index - 1]!;
              const current = requests[index]!;
              for (const [textDigest, envelopeDigest] of previous.userEnvelopes) {
                if (current.userEnvelopes.has(textDigest)) {
                  expect(
                    current.userEnvelopes.get(textDigest),
                    `${route} request ${index + 1}, turn ${current.turn}: retained user envelope ${textDigest}`,
                  ).toBe(envelopeDigest);
                }
              }
              const pruning = current.turn === 9 && previous.turn === 8;
              const firstUserIndex = previous.prefix.history.findIndex((item) =>
                item.includes("visible turn 1"),
              );
              const retainedUserIndex = previous.prefix.history.findIndex((item) =>
                item.includes("visible turn 5"),
              );
              if (pruning) {
                expect(firstUserIndex).toBeGreaterThanOrEqual(0);
                expect(retainedUserIndex).toBeGreaterThan(firstUserIndex);
              }
              let previousPrefix = previous.prefix;
              if (route === "completions" && pruning) {
                // Legacy Chat Completions moves the same Runtime facts to the new
                // first user when the history window retires its original carrier.
                const retired: unknown = JSON.parse(previous.prefix.history[firstUserIndex]!);
                const retained: unknown = JSON.parse(previous.prefix.history[retainedUserIndex]!);
                assert(
                  retired &&
                    typeof retired === "object" &&
                    "content" in retired &&
                    Array.isArray(retired.content),
                );
                assert(
                  retained &&
                    typeof retained === "object" &&
                    "content" in retained &&
                    typeof retained.content === "string",
                );
                const runtime: unknown = retired.content.at(-1);
                assert(
                  runtime &&
                    typeof runtime === "object" &&
                    "type" in runtime &&
                    runtime.type === "text" &&
                    "text" in runtime &&
                    typeof runtime.text === "string" &&
                    runtime.text.startsWith("Runtime: "),
                );
                previousPrefix = {
                  ...previous.prefix,
                  history: previous.prefix.history.with(
                    retainedUserIndex,
                    JSON.stringify({
                      ...retained,
                      content: `${retained.content}\n\n${runtime.text}`,
                    }),
                  ),
                };
              }
              assertStableProviderPrefix(previousPrefix, current.prefix, {
                label: `${route} request ${index + 1}, turn ${current.turn}`,
                ...(route === "messages"
                  ? { historyLength: previous.prefix.breakpoints.at(-1)!.index + 1 }
                  : {}),
                ...(pruning
                  ? {
                      boundary: {
                        kind: "history-pruning" as const,
                        startIndex: firstUserIndex,
                        deleteCount: retainedUserIndex - firstUserIndex,
                      },
                    }
                  : {}),
              });
            }
          } finally {
            observerSpy.mockRestore();
            cleanupSessionResources(sessionId);
            configureAiTransportHost(host);
            clearEmbeddedSessionPromptStates([sessionId]);
          }
        } finally {
          mcp.releaseReconnect();
          await disposeAllSessionMcpRuntimes();
          await mcp.close();
        }
      });
    },
  );
});
