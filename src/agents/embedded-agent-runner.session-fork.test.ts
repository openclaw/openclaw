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
import type { AssistantMessage, ImageContent, Model, ToolCall } from "../llm/types.js";
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
import { runEmbeddedSessionFork } from "./embedded-agent-runner/session-fork.js";
import { Agent, type StreamFn } from "./runtime/index.js";
import * as sessionPlacementAdmission from "./session-placement-admission.js";
import { convertToLlm } from "./sessions/messages.js";
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
  vi.unstubAllGlobals();
});

it.each([
  { api: "openai-completions" as const, provider: "openai", model: "gpt-4o" },
  { api: "openai-responses" as const, provider: "openai", model: "gpt-5.5" },
  { api: "anthropic-messages" as const, provider: "anthropic", model: "claude-sonnet-4-6" },
])(
  "rebuilds real $api bytes during pending placement publications and checks current session authority",
  { timeout: 120_000 },
  async ({ api, provider, model }) => {
    await withOpenClawTestState({ label: `session-fork-${provider}` }, async (state) => {
      await fs.mkdir(state.workspaceDir, { recursive: true });
      await fs.writeFile(
        path.join(state.workspaceDir, "AGENTS.md"),
        "Answer review requests using the REVIEW_CONTEXT_1672 convention.\n",
      );
      const image: ImageContent = {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      };
      const imagePath = path.join(state.workspaceDir, "private-fork-image.png");
      if (api === "openai-responses") {
        await fs.mkdir(state.agentDir(), { recursive: true });
        await fs.writeFile(
          path.join(state.agentDir(), "settings.json"),
          JSON.stringify({ images: { blockImages: true } }),
        );
        await fs.writeFile(imagePath, Buffer.from(image.data, "base64"));
      }
      const toolEntered = createDeferredCore();
      const releaseTool = createDeferredCore();
      let holdParentTool = false;
      let imageResultMode = false;
      const executeTool = vi.fn(async () => {
        if (imageResultMode) {
          return { content: [{ type: "text", text: "PRIVATE_TOOL_IMAGE" }, image], details: {} };
        }
        if (!holdParentTool) {
          throw new Error("FORK TOOL EXECUTED");
        }
        toolEntered.resolve();
        await releaseTool.promise;
        return { content: [{ type: "text", text: "LIVE_TOOL_RESULT_1672" }], details: {} };
      });
      vi.stubGlobal("openclawForkProofTool", executeTool);
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
        `module.exports = { id: "fork-proof", register(api) { api.registerTool({ name: "fork_probe", label: "Probe", description: "Must never execute in a review", parameters: { type: "object", properties: {} }, execute: async () => globalThis.openclawForkProofTool() }); api.on("before_prompt_build", () => ({ prependContext: "Stable plugin context" })); } };`,
      );
      const config = cacheRunnerConfig({
        api,
        provider,
        model,
        workspaceDir: state.workspaceDir,
        pluginId: "fork-proof",
        pluginDir,
        apiKey: "synthetic-fork-key",
        input: ["text", "image"],
        tools: ["fork_probe", ...(api === "openai-responses" ? ["web_search"] : [])],
        modelSettings: {
          agentRuntime: { id: "openclaw" },
          params: {
            transport: "sse",
            cacheRetention: "short",
            ...(api === "openai-completions" ? { extra_body: { tool_choice: "auto" } } : {}),
          },
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
      let sessionReadCurrent = true;
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
          assertCurrent: () => {
            if (!sessionReadCurrent) {
              throw new Error("Session read authority revoked by reset");
            }
          },
          sessionEntry: { sessionId, updatedAt: 1 },
          sessionKey,
          storePath: target.storePath,
          isNewSession: false,
          resolvedReasoningLevel: "off",
          opts: { onBlockReply, abortSignal },
        });
      const runParent = async (prompt: string, runId: string, includeImages = false) => {
        const admission = prepareSystemAgentRunAdmission(config, runId, "main", "fork-proof");
        try {
          const parent = await runEmbeddedAgent({
            preparedRunAdmission: admission,
            userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
              target: { ...target, sessionEntry: undefined },
              input: {
                text: prompt,
                ...(includeImages
                  ? { media: [{ path: imagePath, contentType: "image/png" }] }
                  : {}),
                timestamp: 1,
                idempotencyKey: `${runId}:user`,
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
            runId,
            timeoutMs: 60_000,
            prompt,
            ...(includeImages ? { images: [image] } : {}),
            transcriptPrompt: prompt,
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
      };
      try {
        await runParent("Parent question", "fork-parent");
        expect(payloads).toHaveLength(1);
        const original = structuredClone(payloads[0]!);
        // Reconstruct after process-local transport state is discarded, as after restart.
        cleanupSessionResources(sessionId);
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
        if (api === "openai-responses") {
          expect(JSON.stringify(replayMessages.slice(0, originalMessages.length))).toBe(
            JSON.stringify(originalMessages),
          );
          expect(replayMessages).toHaveLength(originalMessages.length + 2);
          expect(JSON.stringify(replay.instructions)).toBe(JSON.stringify(original.instructions));
        } else {
          // Older routes do not persist their full system prompt or ephemeral temporal carrier.
          // Rebuild from configured bootstrap context while preserving the durable conversation.
          expect(JSON.stringify(replayMessages)).toContain(
            "Stable plugin context\\n\\nParent question",
          );
          if (api === "anthropic-messages") {
            expect(JSON.stringify(replayMessages[0])).toBe(JSON.stringify(originalMessages[0]));
            expect(replayMessages).toHaveLength(3);
          }
        }
        expect(JSON.stringify(original)).toContain("REVIEW_CONTEXT_1672");
        expect(JSON.stringify(replay)).toContain("REVIEW_CONTEXT_1672");
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
        expect(replay.previous_response_id).toBeUndefined();
        expect(replay.prompt_cache_key).toBeUndefined();
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
        if (api === "openai-responses") {
          imageResultMode = true;
          toolsRemaining = 1;
          await runParent("Inspect private images", "fork-parent-images", true);
          imageResultMode = false;
          const assertImagesBlocked = () => {
            const body = JSON.stringify(payloads.at(-1));
            expect(body).toContain("Image reading is disabled.");
            expect(body).toContain("PRIVATE_TOOL_IMAGE");
            expect(body).not.toContain(image.data);
            expect(body).not.toContain('"input_image"');
            expect(body).not.toContain('"image_url"');
          };
          await expect(fork()).resolves.toEqual({ text: "Review answer" });
          assertImagesBlocked();
          holdParentTool = true;
          toolsRemaining = 1;
          const activeParent = runParent("Run the lookup", "fork-parent-active");
          try {
            await Promise.race([
              toolEntered.promise,
              activeParent.then(() => {
                throw new Error("Parent settled before its tool started");
              }),
            ]);
            const whileRunning = await readTranscript();
            await expect(fork()).resolves.toEqual({ text: "Review answer" });
            expect(payloads.at(-1)?.prompt_cache_key).toBeUndefined();
            expect(JSON.stringify(payloads.at(-1))).toContain("This tool call is still running");
            expect(JSON.stringify(payloads.at(-1))).not.toContain("LIVE_TOOL_RESULT_1672");
            expect(await readTranscript()).toEqual(whileRunning);
            expect(executeTool).toHaveBeenCalledTimes(2);
            assertImagesBlocked();
          } finally {
            releaseTool.resolve();
            await activeParent;
            holdParentTool = false;
          }
          expect(JSON.stringify(await readTranscript())).toContain("LIVE_TOOL_RESULT_1672");
        }
        const pluginAbort = new AbortController();
        beforeProviderResponse = () => pluginAbort.abort(new Error("plugin runtime retired"));
        await expect(fork(pluginAbort.signal)).rejects.toThrow();
        const onResetError = vi.fn();
        beforeProviderResponse = () => {
          clearCommittedSessionResetRuntimeState({
            previousSessionEntry: { sessionId },
            agentId: "main",
            sessionKey,
            storePath: target.storePath,
            onError: onResetError,
          });
          // The SDK owns session read authority; cache cleanup is not that authority.
          sessionReadCurrent = false;
        };
        await expect(fork()).rejects.toThrow(
          /^(?:Session read authority revoked by reset|admitted run authority is no longer active)$/,
        );
        expect(onResetError).not.toHaveBeenCalled();
        beforeProviderResponse = undefined;
        const beforeReset = payloads.length;
        await expect(fork()).rejects.toThrow(
          /^(?:Session read authority revoked by reset|admitted run authority is no longer active)$/,
        );
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
    streamFn: transport,
  });
  const reviewFork = (question: string) =>
    runEmbeddedSessionFork({
      context: {
        systemPrompt: agent.state.systemPrompt,
        messages: convertToLlm(agent.state.messages),
        tools: agent.state.tools,
      },
      streamFn: transport,
      model: loopModel,
      question,
      assertCurrent() {},
    });
  const unsubscribe = agent.subscribe((event) => {
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
    await expect(reviewFork("Review after transport cleanup")).resolves.toBe("Review answer");
    expect(JSON.stringify(payloads.at(-1))).toContain("PARENT_FINAL_4837");
  } finally {
    unsubscribe();
  }
});
