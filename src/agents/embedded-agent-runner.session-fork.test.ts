import fs from "node:fs/promises";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { clearCommittedSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { stagePlacementWorkspaceJournalWorkerPublication } from "../gateway/worker-environments/placement-turn-authority.js";
import type { AssistantMessage, Model, ToolCall } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { readBtwTranscriptMessages, resolveBtwSessionTranscriptPath } from "./btw-transcript.js";
import { runBtwSideQuestion } from "./btw.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import {
  cacheRunnerConfig,
  providerResponse,
  type WireApi,
} from "./embedded-agent-runner.wire.test-support.js";
import {
  runEmbeddedSessionFork,
  wrapStreamFnWithSessionFork,
} from "./embedded-agent-runner/session-fork.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { Agent, type StreamFn } from "./runtime/index.js";
import * as sessionPlacementAdmission from "./session-placement-admission.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const response = (api: WireApi, model: string, tool: boolean): Response =>
  providerResponse({
    api,
    model,
    id:
      api === "openai-responses"
        ? "resp_fork"
        : api === "anthropic-messages"
          ? "msg_fork"
          : "chatcmpl_fork",
    messageId: "msg_fork",
    text: "Review answer",
    cacheRead: 900,
    completedToolStatus: true,
    completionModel: true,
    done: api === "openai-completions",
    calls: tool
      ? [
          {
            id: api === "anthropic-messages" ? "toolu_fork" : "call_fork",
            itemId: "fc_fork",
            name: "fork_probe",
          },
        ]
      : [],
  }).response;

afterEach(async () => {
  cleanupSessionResources();
  await clearActivePluginRegistry();
});

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
      const config = cacheRunnerConfig({
        api,
        provider,
        model,
        workspaceDir: state.workspaceDir,
        pluginId: "fork-proof",
        pluginDir,
        apiKey: "synthetic-fork-key",
        input: ["text"],
        tools: ["fork_probe", ...(api === "openai-responses" ? ["web_search"] : [])],
        modelSettings: {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", cacheRetention: "short" },
        },
      });
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
        expect(replayMessages).toHaveLength(originalMessages.length + 2);
        expect(JSON.stringify(replayMessages.at(-2))).toContain("Review answer");
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

const loopModel: Model = makeProviderModelFixture({
  id: "fork-fixture",
  name: "Fork fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  contextWindow: 10000,
  maxTokens: 1000,
});
const loopIdentity = { agentId: "main", sessionId: "fork-async-tail", runId: "fork-async-tail" };
function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: loopModel.api,
    provider: loopModel.provider,
    model: loopModel.id,
    content,
    stopReason: "stop",
    usage: createZeroUsageFixture(),
    timestamp: 1,
  };
}

it("forks the canonical completed async tool fragments and outcomes in order", async () => {
  const payloads: unknown[] = [];
  const reviewFork = (question: string) =>
    runEmbeddedSessionFork({ ...loopIdentity, model: loopModel, question, assertCurrent() {} });
  const ready = createDeferredCore();
  const resultPublished = createDeferredCore();
  const parentResponse = createAssistantMessageEventStream();
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "lookup-call",
    name: "lookup",
    arguments: {},
    async: true,
  };
  const transport: StreamFn = async (requestModel, context, options) => {
    const payload = { input: structuredClone(context.messages) };
    payloads.push((await options?.onPayload?.(payload, requestModel)) ?? payload);
    if (payloads.length === 1) {
      ready.resolve();
      return parentResponse;
    }
    const review = createAssistantMessageEventStream();
    review.end(assistant([{ type: "text", text: "Review answer" }]));
    return review;
  };
  const agent = new Agent({
    initialState: {
      model: loopModel,
      tools: [
        {
          name: "lookup",
          label: "Lookup",
          description: "Synthetic asynchronous lookup",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "TOOL_RESULT_4837" }],
            details: {},
            terminate: true,
          }),
        },
      ],
    },
    streamFn: wrapStreamFnWithSessionFork(transport, loopIdentity),
  });
  const { session, emit } = createStubSessionHarness();
  Object.assign(session, { agent });
  const subscription = subscribeEmbeddedAgentSession({
    session,
    ...loopIdentity,
  });
  const unsubscribe = agent.subscribe((event) => {
    emit(event);
    if (event.type === "message_end" && event.message.role === "toolResult") {
      resultPublished.resolve();
    }
  });
  try {
    const run = agent.prompt("Parent question");
    await ready.promise;
    parentResponse.push({ type: "start", partial: assistant([]) });
    parentResponse.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: assistant([toolCall]),
    });
    await resultPublished.promise;
    parentResponse.push({
      type: "done",
      reason: "stop",
      message: assistant([toolCall, { type: "text", text: "PARENT_FINAL_4837" }]),
    });
    parentResponse.end();
    await run;
    await subscription.waitForPendingEvents();
    await expect(reviewFork("Review completed turn")).resolves.toBe("Review answer");
    expect(payloads.at(-1)).toEqual({
      input: [
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Parent question" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "toolCall", id: "lookup-call" })],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "lookup-call",
          content: [{ type: "text", text: "TOOL_RESULT_4837" }],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "PARENT_FINAL_4837" }],
        }),
        expect.objectContaining({ role: "user", content: "Review completed turn" }),
      ],
    });
    cleanupSessionResources(loopIdentity.sessionId);
    emit({ type: "message_end", message: assistant([{ type: "text", text: "OLD_RUN" }]) });
    await expect(reviewFork("After reset")).rejects.toThrow("requires a parent turn");
    const nextParent = wrapStreamFnWithSessionFork(transport, {
      ...loopIdentity,
      runId: "replacement-run",
    });
    await nextParent(
      loopModel,
      { messages: [{ role: "user", content: "Replacement parent", timestamp: 2 }] },
      {},
    );
    emit({ type: "message_end", message: assistant([{ type: "text", text: "OLD_RUN" }]) });
    await reviewFork("Review replacement");
    expect(payloads.at(-1)).toEqual({
      input: [
        { role: "user", content: "Replacement parent", timestamp: 2 },
        expect.objectContaining({ role: "user", content: "Review replacement" }),
      ],
    });
  } finally {
    unsubscribe();
    subscription.unsubscribe();
  }
});
