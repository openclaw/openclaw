// End-to-end prompt reuse through the admitted runner, durable transcript and real serializers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { stableStringify } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createCurrentPromptReaction } from "../gateway/current-prompt-reaction.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import { RUNTIME_CONTEXT_HEADER } from "../llm/types.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { resolveActiveReplyOperationForSessionId } from "../sessions/session-controller.queries.js";
import { steerSessionControllerOperation } from "../sessions/session-controller.steer.js";
import { bindUserTurnPromptReactionSource } from "../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { bindSessionMcpRuntimeTestScheduler } from "./agent-bundle-mcp-manager.test-support.js";
import { disposeAllSessionMcpRuntimes, peekSessionMcpRuntime } from "./agent-bundle-mcp-tools.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import {
  cacheRunnerConfig,
  omitWireFields,
  providerResponse,
  type WireApi,
} from "./embedded-agent-runner.wire.test-support.js";
import * as promptCacheRequestObserver from "./embedded-agent-runner/prompt-cache-request-observer.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "./internal-runtime-context.js";
import { SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION } from "./subagents/completion/subagent-completion-instructions.js";
import { startPromptCacheMcpServer } from "./test-helpers/prompt-cache-mcp.test-support.js";

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
] satisfies Array<{ api: WireApi; provider: string; model: string; route: string }>;
const PNG = createSolidPngBuffer(1, 1, { r: 12, g: 34, b: 56 }).toString("base64");
const FAILED_ASSISTANT_TEXT = "partial assistant output before provider error";
const FAILED_ASSISTANT_REPLAY_TEXT =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";

function responseFor(api: WireApi, model: string, request: number, tool: boolean, failure = false) {
  const id = `cache_${request}`;
  return providerResponse({
    api,
    model,
    id,
    messageId: `msg_${id}`,
    text: `answer ${request}`,
    calls: tool
      ? Array.from({ length: 5 }, (_, index) => ({
          id: `${api === "anthropic-messages" ? "toolu" : "call"}_${id}_${index}`,
          name: "cache_probe",
        }))
      : [],
    ...(failure
      ? {
          failure: {
            text: FAILED_ASSISTANT_TEXT,
            code: "invalid_request_error",
            message: "Synthetic terminal provider failure",
          },
        }
      : {}),
  });
}

afterEach(async () => {
  await clearActivePluginRegistry();
});

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
        const config = cacheRunnerConfig({
          api,
          provider,
          model,
          workspaceDir: state.workspaceDir,
          pluginId: "cache-proof",
          pluginDir,
          apiKey: "synthetic-cache-proof",
          input: ["text", "image"],
          tools: ["cache_probe", "cache_fixture__probe", "message"],
          modelSettings: {
            params: { transport: "sse", openaiWsWarmup: false, cacheRetention: "short" },
          },
        });
        config.channels = { telegram: { enabled: false, dmHistoryLimit: 5 } };
        config.mcp = mcp.config;
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
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
        let assistantHistory: string[] = [];
        let providerFailure: Error | undefined;
        const createObserver = promptCacheRequestObserver.createPromptCacheRequestObserver;
        const observerSpy = vi
          .spyOn(promptCacheRequestObserver, "createPromptCacheRequestObserver")
          .mockImplementation((...args) => {
            const observer = createObserver(...args);
            return {
              ...observer,
              onModelRequest: (runtimeModel, context) => {
                if (api === "openai-responses" && turn <= 4) {
                  const assistants = context.messages
                    .filter((message) => message.role === "assistant")
                    .map((message) => stableStringify(message));
                  for (let index = 0; index < assistantHistory.length; index++) {
                    if (assistants[index] !== assistantHistory[index]) {
                      providerFailure = new Error(`assistant replay changed at assistant ${index}`);
                      throw providerFailure;
                    }
                  }
                  assistantHistory = assistants;
                }
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
                assert(isRecord(payload));
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
                expect(prefix.breakpoints.length, "legacy Messages cache boundary").toBeGreaterThan(
                  0,
                );
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
              expect(prefix.tools, "advertised tool").toContain('"name":"cache_probe"');
              requests.push({ turn, payload, prefix, userEnvelopes });
              requestsThisTurn++;
              if (turn === 6 && requestsThisTurn === 1) {
                const outcome = await steerSessionControllerOperation({
                  operation: resolveActiveReplyOperationForSessionId(sessionId),
                  text: "mid-run steering correction",
                  options: { steeringMode: "all" },
                });
                expect(outcome.status, "the active runner accepted steering").toBe("accepted");
              }
              if (requestsThisTurn > 4) {
                throw new Error(`Unexpected provider retry in synthetic turn ${turn}`);
              }
              // Replay the error in turn 6, then verify those sent bytes after reopen in turn 7.
              const failure = api === "openai-responses" && turn === 5 && requestsThisTurn === 1;
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
                const output = result.output.map((item) =>
                  omitWireFields(item, item.type === "function_call" ? ["id", "status"] : ["id"]),
                );
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
            // Alternate real WebChat prompt authority with ordinary follow-up runs.
            // Tool presentation must not depend on this one-turn capability.
            const source = {
              agentId: "main",
              sessionKey,
              assertCurrent: admission.assertSourceCurrent,
              createReaction: (sourceRecorder: typeof recorder) =>
                createCurrentPromptReaction({
                  ...target,
                  recorder: sourceRecorder,
                  context: { broadcast: () => {}, getRuntimeConfig: () => config },
                }),
            };
            bindUserTurnPromptReactionSource(recorder, source);
            const capability =
              api === "openai-responses" && turn % 2 === 1
                ? mintMessageActionTurnCapability({
                    ...target,
                    runId,
                    expiresWithRun: true,
                    promptReactionSource: { source, recorder },
                  })
                : undefined;
            try {
              const run = runEmbeddedAgent({
                userTurnTranscriptRecorder: recorder,
                messageActionTurnCapability: capability,
                messageProvider: api === "openai-responses" ? "webchat" : "telegram",
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
                toolsAllow: ["cache_probe", "cache_fixture__probe", "message"],
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
              if (api === "openai-responses" && turn === 5) {
                await expect(run).rejects.toMatchObject({ reason: "format" });
                if (providerFailure) {
                  throw providerFailure;
                }
                expect(requestsThisTurn, "permanent failure is not retried").toBe(1);
                continue;
              }
              const result = await run;
              if (providerFailure) {
                throw providerFailure;
              }
              expect(result.meta.aborted, `turn ${turn} aborted`).not.toBe(true);
              expect(
                requestsThisTurn,
                `turn ${turn} reached provider ${JSON.stringify(result.meta)}`,
              ).toBeGreaterThan(0);
              expect(
                result.payloads?.some((payload) => payload.text?.includes("answer")),
                `turn ${turn} completed`,
              ).toBe(true);
            } finally {
              if (capability) {
                revokeMessageActionTurnCapability(capability);
              }
              admission.close();
            }
          }
          expect(requests.length).toBe(12);
          const historyAt = (value: number) =>
            requests.find((request) => request.turn === value)!.prefix.history.join("");
          if (api === "openai-responses") {
            expect(requests.filter((request) => request.turn === 5)).toHaveLength(1);
            const afterFailure = historyAt(6);
            expect(
              afterFailure,
              "next turn retains the failed assistant identity without replaying unfinished text",
            ).toContain(FAILED_ASSISTANT_REPLAY_TEXT);
            expect(afterFailure).not.toContain(FAILED_ASSISTANT_TEXT);
            expect(
              historyAt(7),
              "the already-sent failed-turn replay stays identical in the following run",
            ).toContain(FAILED_ASSISTANT_REPLAY_TEXT);
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
          expect(firstPrefix, "plugin prepend hook reached provider").toContain("hook before");
          expect(firstPrefix, "plugin append hook reached provider").toContain("hook after");
          expect(firstPrefix, "image reached provider").toContain(PNG);
          expect(historyAt(2), "model-only replacement reached provider").toContain(
            "replacement model prompt 2",
          );
          const toolResults = requests[1]!.prefix.history.filter((segment) =>
            segment.includes("synthetic tool result"),
          );
          expect(toolResults.length).toBe(5);
          expect(
            toolResults.reduce((bytes, segment) => bytes + segment.length, 0),
            "five fresh 16k results exceed the aggregate budget; sent bytes must stay frozen",
          ).toBeGreaterThan(65_536);
          expect(historyAt(8), "announcement context reached provider").toContain(
            "Synthetic child verification completed",
          );
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
              assert(isRecord(retired) && Array.isArray(retired.content));
              assert(isRecord(retained) && typeof retained.content === "string");
              const runtime: unknown = retired.content.at(-1);
              assert(
                isRecord(runtime) &&
                  runtime.type === "text" &&
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
