import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { type ProviderMessage } from "../../../../packages/ai/src/provider-types.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { markInboundContextLabel } from "../../../auto-reply/reply/inbound-context-marker.js";
import { stageSessionPendingInput } from "../../../config/sessions/session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { cloneTranscriptView } from "../../../config/sessions/transcript-snapshot.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { labelRuntimeContextText } from "../../../llm/types.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { type PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { freezeJsonSnapshot } from "../../../shared/immutable-data.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { convertToLlm } from "../../sessions/messages.js";
import { convertToLlmWithBlockImages } from "../../sessions/messages.js";
import { convertToLlm as convertHarnessMessages } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { beginPromptCacheObservation } from "../prompt-cache-observability.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { recordToolResultPromptProjection } from "../session-prompt-state.js";
import { type ToolResultPromptProjectionState } from "../session-prompt-state.js";
import { bindToolResultPromptProjectionKeys } from "../tool-result-projection-key.js";
import { projectToolResultMessages } from "../tool-result-truncation.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import {
  createActiveSession,
  createBoundaryInputDefaults,
  createSessionManager,
} from "./attempt-session-boundary.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { materializeProviderContext } from "./images.js";
import { applyRuntimeContextCarrierRetention } from "./runtime-context-prompt.js";
import { buildSystemUpdateMessage } from "./runtime-context-prompt.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

describe("prepareEmbeddedAttemptSessionBoundary", () => {
  it("strips persisted carriers when a session switches to transient replay", async () => {
    const previousUser: AgentMessage = { role: "user", content: "first question", timestamp: 1 };
    const previousCarrier: AgentMessage = buildRuntimeContextCustomMessage("persisted context")!;
    previousCarrier.details = { runtimeContextCarrier: true };
    const reply = makeAssistantMessageFixture({
      content: [{ type: "text", text: "first answer" }],
    });
    const currentCarrier = buildRuntimeContextCustomMessage("current context")!;
    const currentUser: AgentMessage = { role: "user", content: "next question", timestamp: 2 };
    const messages = [previousUser, previousCarrier, reply, currentCarrier, currentUser];
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: false,
      attempt: { sessionId: "session-boundary", prompt: "next question" },
      getUserTranscriptContexts: () => undefined,
      ...createBoundaryInputDefaults(),
    });
    const converted = await activeSession.agent.convertToLlm(messages);
    expect(converted).toHaveLength(4);
    expect(converted).not.toContain(previousCarrier);
    expect(converted.at(-1)).toBe(currentCarrier);
    expect(converted.slice(0, -1)).not.toContain(currentCarrier);
    expect(await activeSession.agent.convertToLlm(messages)).toEqual(converted);
  });

  it.each([false, true])(
    "replays turn and tool-loop prefixes with append-only runtime context %s",
    async (appendOnlyRuntimeContext) =>
      withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
        const { activeSession } = createActiveSession();
        activeSession.agent.convertToLlm = convertHarnessMessages;
        const sessionId = `boundary-cache-${appendOnlyRuntimeContext}`;
        const observe = (messages: Parameters<typeof beginPromptCacheObservation>[0]["messages"]) =>
          beginPromptCacheObservation({
            sessionId,
            provider: "test-provider",
            modelId: "test-model",
            streamStrategy: "test",
            systemPrompt: "Stable system prompt",
            tools: [],
            messages,
          });
        await prepareEmbeddedAttemptSessionBoundary({
          activeSession,
          appendOnlyRuntimeContext,
          attempt: {
            sessionId,
            config: { agents: { defaults: { userTimezone: "UTC" } } },
            prompt: "first question",
          },
          getUserTranscriptContexts: () => undefined,
          ...createBoundaryInputDefaults(),
        });
        const user = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `${markInboundContextLabel("Conversation info:")}\n\`\`\`json\n{"channel":"discord"}\n\`\`\`\n\nfirst question`,
            },
          ],
          timestamp: 1_717_570_800_000,
        };
        const carrier = buildRuntimeContextCustomMessage("first turn context")!;
        const messages: AgentMessage[] = appendOnlyRuntimeContext
          ? [user, carrier]
          : [carrier, user];
        const first = await activeSession.agent.convertToLlm(messages);
        expect(observe(first).changes).toBeNull();
        expect(first).toHaveLength(2);
        expect(first[1]).toMatchObject({
          role: "user",
          content: labelRuntimeContextText(carrier.content),
          runtimeContext: { retained: appendOnlyRuntimeContext },
          runtimeContextCarrier: true,
          runtimeContextCarrierRetained: appendOnlyRuntimeContext,
        });
        messages.push(
          makeAssistantMessageFixture({
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
            isError: false,
            timestamp: user.timestamp + 1,
          },
        );
        const toolLoop = await activeSession.agent.convertToLlm(messages);
        expect(observe(toolLoop).changes).toEqual(
          appendOnlyRuntimeContext
            ? null
            : [expect.objectContaining({ code: "runtimeContextCarrier" })],
        );
        if (appendOnlyRuntimeContext) {
          expect(JSON.stringify(toolLoop.slice(0, first.length))).toBe(JSON.stringify(first));
        } else {
          expect(toolLoop.at(-1)).toEqual(first[1]);
        }
        expect(observe(await activeSession.agent.convertToLlm(messages)).changes).toBeNull();
        const nextUser = {
          role: "user" as const,
          content: "next question",
          timestamp: user.timestamp + 60_000,
        };
        const nextCarrier = buildRuntimeContextCustomMessage("second turn context")!;
        messages.push(makeAssistantMessageFixture({ content: [{ type: "text", text: "done" }] }));
        messages.push(
          ...(appendOnlyRuntimeContext ? [nextUser, nextCarrier] : [nextCarrier, nextUser]),
        );
        const next = await activeSession.agent.convertToLlm(messages);
        expect(observe(next).changes).toEqual(
          appendOnlyRuntimeContext
            ? null
            : [expect.objectContaining({ code: "runtimeContextCarrier" })],
        );
        if (appendOnlyRuntimeContext) {
          expect(JSON.stringify(next.slice(0, toolLoop.length))).toBe(JSON.stringify(toolLoop));
          expect(next[1]).toEqual(first[1]);
          expect(next[0]!.content).toContain("Conversation info:");
        } else {
          expect(next).not.toContainEqual(first[1]);
          expect(next[0]!.content).toContain("Conversation info:");
        }
        expect(next.at(-1)).toMatchObject({
          role: "user",
          content: labelRuntimeContextText(nextCarrier.content),
        });
      }),
  );

  it("resets restored state and preserves exact prompt bytes for raw model probes", async () => {
    const { activeSession, reset } = createActiveSession();
    const setActiveSessionSystemPrompt = vi.fn();

    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { sessionId: "session-boundary", prompt: "exact probe" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: true,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt,
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "exact probe" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).toHaveBeenCalledOnce();
    expect(setActiveSessionSystemPrompt).toHaveBeenCalledWith("");
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("exact probe");
    expect((converted[0] as { content?: unknown }).content).not.toContain("Conversation info");
  });

  it("preserves settled history while isolating the finalization prompt", async () => {
    const { activeSession, reset } = createActiveSession();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
    });
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        sessionId: "session-boundary",
        operation: "settled-tool-finalization",
        prompt: "finalize exactly",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "finalize exactly" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).not.toHaveBeenCalled();
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("finalize exactly");
  });

  it("applies the prepared current-turn timestamp at the LLM boundary", async () => {
    const { activeSession } = createActiveSession();
    const preparedTimestamp = 1_717_570_800_000;
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        sessionId: "session-boundary",
        config: { agents: { defaults: { userTimezone: "UTC" } } },
        prompt: "Current ask",
      },
      getUserTranscriptContexts: () => undefined,
      ...createBoundaryInputDefaults(),
    });
    boundary.setCurrentUserTimestampOverride({
      timestamp: preparedTimestamp,
      text: "Current ask",
    });

    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: preparedTimestamp + 60_000,
      },
    ]);

    expect((converted[0] as { content?: unknown }).content).toBe(
      `${buildTimestampPrefix(new Date(preparedTimestamp), { timezone: "UTC" })}Current ask`,
    );
  });

  for (const { name, prompt, messages, contextOrder } of [
    {
      name: "retains sender projection for earlier in-memory turns after a queued turn",
      prompt: "The launch is Friday",
      messages: [
        {
          text: "The launch is Friday",
          timestamp: 1,
          sender: { senderId: "alice-id", senderName: "Alice" },
        },
        {
          text: "I can present it",
          timestamp: 2,
          sender: { senderId: "bob-id", senderName: "Bob" },
        },
      ],
      contextOrder: [0, 1],
    },
    {
      name: "reserves exact pairings before matching duplicate timestamp and text",
      prompt: "same",
      messages: [
        { text: "same", timestamp: 1, sender: { senderName: "Alice" } },
        { text: "same", timestamp: 1, sender: { senderName: "Bob" } },
      ],
      contextOrder: [1, 0],
    },
  ] as const) {
    it(name, async () => {
      const runtimeMessages = messages.map(
        ({ text, timestamp }) =>
          ({
            role: "user",
            content: [{ type: "text", text }],
            timestamp,
          }) as AgentMessage,
      );
      const { activeSession } = createActiveSession();
      await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: { sessionId: "session-boundary", prompt },
        getUserTranscriptContexts: () =>
          contextOrder.map((index) => ({
            runtimeMessage: runtimeMessages[index]!,
            transcriptMessage: {
              role: "user",
              content: messages[index].text,
              timestamp: messages[index].timestamp,
              __openclaw: { ...messages[index].sender },
            } as AgentMessage,
          })),
        ...createBoundaryInputDefaults(),
      });

      const converted = await activeSession.agent.convertToLlm(runtimeMessages);

      expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
      expect((converted[1] as { content?: unknown }).content).toContain('"name":"Bob"');
    });
  }
});

registerAgentSessionLoopTestLifecycle();

type Target = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Recorder = ReturnType<typeof createUserTurnTranscriptRecorder>;

function withLiveInput(
  run: (target: Target, prior: ReturnType<typeof createAssistant>) => Promise<void>,
) {
  return withOpenClawTestState({ label: "live-input" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "live-input-session",
      sessionKey: "agent:main:live-input",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = guardSessionManager(
      await SessionManager.openAsync(target, state.workspaceDir),
      {
        runId: "prior-run",
      },
    );
    const prior = createAssistant(testModel, [{ type: "text", text: "prior reply" }]);
    await manager.appendMessageAsync(prior);
    await run(target, prior);
  });
}

function prepareLiveInputBoundary(
  session: AgentSession,
  target: Target,
  prompt: string,
  recorder?: Recorder,
  message?: Parameters<typeof prepareEmbeddedAttemptSessionBoundary>[0]["preparedUserTurnMessage"],
) {
  return prepareEmbeddedAttemptSessionBoundary({
    activeSession: session,
    attempt: {
      prompt,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      userTurnTranscriptRecorder: recorder,
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: message,
    sessionManager: session.sessionManager,
    setActiveSessionSystemPrompt: vi.fn(),
  });
}

function replyWith(text: string) {
  streamMocks.streamSimple.mockImplementation((model) =>
    createAssistantResultStream(createAssistant(model, [{ type: "text", text }])),
  );
}

describe("live steering at the attempt boundary", () => {
  it("delivers live input steered into the run after the boundary sampled it", async () => {
    await withLiveInput(async (target) => {
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "correction steered into the run",
          timestamp: 2,
          idempotencyKey: "correction-run:user",
        },
        target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
        updateMode: "none",
      });
      expect(
        await recorder.stageApproved?.({ runId: "correction-run", assertCurrent: () => {} }),
      ).toBe(true);
      const foreign = expectDefined(
        await stageSessionPendingInput(target, {
          runId: "queued-run",
          message: {
            role: "user",
            content: "queued user request",
            timestamp: 3,
            idempotencyKey: "queued-run:user",
          },
          assertCurrent: () => {},
        }),
        "Expected queued receipt",
      );
      try {
        const foreignRecorder = createUserTurnTranscriptRecorder({
          message: foreign.message,
          target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
          updateMode: "none",
        });
        await foreign.run(() => foreignRecorder.persistApproved());
        const manager = guardSessionManager(
          await SessionManager.openBoundedAsync(target, { maxBytes: 8192, maxEvents: 30 }),
          { runId: "active-run" },
        );
        const { session: activeSession } = await createTestSession({
          model: testModel,
          sessionManager: manager,
        });
        // Recovery compaction prepares a new attempt while the correction is still live custody.
        await prepareLiveInputBoundary(activeSession, target, "original request");
        const entered = createDeferred();
        const held = holdAssistantResponse("working on the original request");
        streamMocks.streamSimple.mockImplementationOnce(() => {
          entered.resolve();
          return held.response;
        });
        replyWith("correction applied");
        const run = activeSession.prompt("original request", { expandPromptTemplates: false });
        await entered.promise;
        // This run's steering queue accepts the correction after the boundary sampled it.
        await activeSession.steer("correction steered into the run", undefined, recorder);
        held.release();
        await run;
        expect(activeSession.getLastAssistantText()).toBe("correction applied");
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        const corrected = JSON.stringify(streamMocks.streamSimple.mock.calls[1]?.[1].messages);
        expect(corrected).toContain("correction steered into the run");
        // Adoption is per input: another turn's live input stays out of this run.
        expect(corrected).not.toContain("queued user request");
        activeSession.dispose();
      } finally {
        recorder.finishPendingInput?.("interrupted");
        foreign.finish("interrupted");
      }
    });
  });

  it("includes accepted steering that was pending during boundary preparation", async () => {
    await withLiveInput(async (target) => {
      const receipt = expectDefined(
        await stageSessionPendingInput(target, {
          runId: "early-steer",
          message: {
            role: "user",
            content: "early steering instruction",
            timestamp: 2,
            idempotencyKey: "early-steer:user",
          },
          assertCurrent: () => {},
        }),
        "Expected early input custody",
      );
      const recorder = createUserTurnTranscriptRecorder({
        message: receipt.message,
        target: { ...target, sessionEntry: undefined },
        updateMode: "none",
      });
      const manager = guardSessionManager(await SessionManager.openAsync(target), {
        runId: "active-run",
      });
      const { session: activeSession } = await createTestSession({
        model: testModel,
        sessionManager: manager,
      });
      try {
        await prepareLiveInputBoundary(activeSession, target, "original request");
        // Preparation samples the separate pending source before native steering
        // admission joins that input to this runtime before its first call.
        expect(
          JSON.stringify(
            await activeSession.agent.convertToLlm(manager.buildSessionContext().messages),
          ),
        ).not.toContain("early steering instruction");
        await activeSession.steer(
          "early steering instruction",
          undefined,
          recorder,
          undefined,
          undefined,
          "early-steering-identity",
        );
        replyWith("early steering answered");
        await receipt.run(() =>
          activeSession.prompt("original request", { expandPromptTemplates: false }),
        );
        expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        const modelInput = JSON.stringify(streamMocks.streamSimple.mock.calls[0]?.[1].messages);
        expect(modelInput.match(/early steering instruction/g) ?? []).toHaveLength(1);
        expect(activeSession.getLastAssistantText()).toBe("early steering answered");
      } finally {
        activeSession.dispose();
        receipt.finish("interrupted");
      }
    });
  });
});

describe("turn media and replay policy boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const MP4_HEADER = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
  // Projects with a copy of the state, leaving the original's pruning state unchanged.
  const replayToolResultPromptProjections = (
    messages: AgentMessage[],
    state: ToolResultPromptProjectionState,
  ) =>
    projectToolResultMessages({
      messages,
      projectionState: createToolResultPromptProjectionState(state),
    }).messages;

  function userMessage(text: string, timestamp: number) {
    return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
  }

  function videoBlocks(message: ProviderMessage | undefined) {
    expect(message?.role).toBe("user");
    return message?.role === "user" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "video")
      : [];
  }

  it("keeps historical and runtime video on their own turns across queued text and carriers", async () => {
    const workspaceDir = tempDirs.make("openclaw-video-boundary-");
    const historicalVideo = Buffer.concat([MP4_HEADER, Buffer.from([0x11])]);
    const currentVideo = Buffer.concat([MP4_HEADER, Buffer.from([0x22])]);
    const historicalPath = path.join(workspaceDir, "historical.mp4");
    const currentPath = path.join(workspaceDir, "current.mp4");
    await Promise.all([
      fs.writeFile(historicalPath, historicalVideo),
      fs.writeFile(currentPath, currentVideo),
    ]);

    const historical = buildPersistedUserTurnMessage({
      text: "Historical video",
      timestamp: 1,
      media: [{ path: historicalPath, contentType: "video/mp4", kind: "video" }],
    });
    Object.freeze(historical);
    const current = attachRuntimePromptMediaFacts(userMessage("Current video", 2), [
      { path: currentPath, contentType: "video/mp4", kind: "video" },
    ]);
    // Prompt/sender projection must preserve media held only by the runtime carrier.
    const currentTranscript: PersistedUserTurnMessage = {
      role: "user",
      content: "Current video",
      timestamp: 2,
      __openclaw: {
        senderName: "Video sender",
        modelPromptProjection: { version: 1, text: "Projected current video" },
      },
    };
    const carrier = buildRuntimeContextCustomMessage("Current turn context")!;
    const queued = userMessage("Queued text without an attachment", 3);
    const original: AgentMessage[] = [historical, current, carrier];
    const inputs = [original, queued, currentTranscript];
    const originalJson = JSON.stringify(inputs);
    for (const messages of [original, [...original, queued]]) {
      const normalized = normalizeMessagesForLlmBoundary(messages, {
        sessionVersion: 4,
        appendOnlyRuntimeContext: true,
        timezone: "UTC",
        userTranscriptContexts: [{ runtimeMessage: current, transcriptMessage: currentTranscript }],
      });
      const converted = convertToLlm(normalized);
      applyRuntimeContextCarrierRetention(converted, true);
      const provider = await materializeProviderContext({
        context: { messages: converted },
        workspaceDir,
        localRoots: [workspaceDir],
      });
      const expectedVideos = [historicalVideo, currentVideo].map((video) => [
        { type: "video", data: video.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(provider.messages.map(videoBlocks)).toEqual([
        ...expectedVideos,
        [],
        ...(messages.length === 4 ? [[]] : []),
      ]);
      for (const text of ["Projected current video", "Video sender"]) {
        expect(provider.messages[1]?.content).toContainEqual({
          type: "text",
          text: expect.stringContaining(text),
        });
      }
      expect(provider.messages[2]).toMatchObject({
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: true,
      });
      if (messages.length === 4) {
        expect(provider.messages[3]?.content).toContain("Queued text without an attachment");
      }
    }
    expect(JSON.stringify(inputs)).toBe(originalJson);
  });
  it("isolates image, replay, and retention policies without exposing private details", () => {
    const tool = freezeJsonSnapshot({
      role: "toolResult" as const,
      toolCallId: "call",
      toolName: "read",
      isError: false,
      content: [{ type: "text" as const, text: "full result" }],
      details: { internal: true },
      timestamp: 2,
    });
    const source: AgentMessage[] = freezeJsonSnapshot([
      { role: "user", content: "hello", timestamp: 1 },
      tool,
      { role: "custom", customType: "note", content: "note", display: false, timestamp: 3 },
      buildRuntimeContextCustomMessage("runtime facts")!,
      buildSystemUpdateMessage("update", "prompt-update", true),
      {
        role: "user",
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        timestamp: 6,
      },
    ]);
    const state = createToolResultPromptProjectionState();
    recordToolResultPromptProjection(state, "tool:call:2", {
      ...tool,
      content: [{ type: "text", text: "short result" }],
    });
    const otherState = createToolResultPromptProjectionState();
    recordToolResultPromptProjection(otherState, "tool:call:2", {
      ...tool,
      content: [{ type: "text", text: "other limit" }],
    });
    const prepare = (
      blockImages: boolean,
      retained: boolean | undefined,
      updates = true,
      projections = state,
    ) => {
      const messages = bindToolResultPromptProjectionKeys(
        cloneTranscriptView(source),
        createToolResultPromptProjectionState(projections),
      );
      const normalized = normalizeMessagesForLlmBoundary(
        replayToolResultPromptProjections(messages, projections),
        {
          sessionVersion: 4,
          includeTimestamp: false,
          appendOnlyRuntimeContext: true,
          inHistorySystemUpdates: updates,
        },
      );
      const converted = convertToLlmWithBlockImages(normalized, blockImages);
      applyRuntimeContextCarrierRetention(converted, retained);
      return converted;
    };
    const first = prepare(false, true);
    const bytes = JSON.stringify(first);
    expect(first[1]).toMatchObject({ content: [{ type: "text", text: "short result" }] });
    expect(first[1]).not.toHaveProperty("details");
    expect(first[2]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "note" }],
      synthetic: true,
    });
    {
      const retained = false;
      const other = prepare(true, retained, false, otherState);
      expect(other[1]).toMatchObject({ content: [{ type: "text", text: "other limit" }] });
      expect(other[3]).toHaveProperty("runtimeContext.retained", retained);
      expect(other[4]).not.toHaveProperty("operatorMessage");
      expect(other[5]).toMatchObject({
        content: [{ type: "text", text: "Image reading is disabled." }],
      });
      const next = prepare(false, true);
      expect(JSON.stringify(next)).toBe(bytes);
    }
    expect(tool.content[0]?.text).toBe("full result");
    expect(tool.details).toEqual({ internal: true });
  });
});
