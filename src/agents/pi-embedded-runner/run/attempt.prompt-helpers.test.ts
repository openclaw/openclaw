import { describe, expect, it, vi } from "vitest";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../test-helpers/agent-message-fixtures.js";

const musicGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(),
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => "Music generation task status"),
  findActiveMusicGenerationTaskForSession: vi.fn(),
  MUSIC_GENERATION_TASK_KIND: "music_generation",
}));

const videoGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(),
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => "Video generation task status"),
  findActiveVideoGenerationTaskForSession: vi.fn(),
  getVideoGenerationTaskProviderId: vi.fn(),
  isActiveVideoGenerationTask: vi.fn(() => false),
  VIDEO_GENERATION_TASK_KIND: "video_generation",
}));

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../../music-generation-task-status.js", () => musicGenerationTaskStatusMocks);
vi.mock("../../video-generation-task-status.js", () => videoGenerationTaskStatusMocks);
vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import {
  forgetPromptBuildDrainCacheForRun,
  resolveTrailingUserPromptRepair,
  resolveSuppressedCurrentUserTranscriptContext,
  resolvePromptSubmissionSkipReason,
  resolveAttemptPrependSystemContext,
  resolvePromptBuildHookResult,
} from "./attempt.prompt-helpers.js";

describe("resolveAttemptPrependSystemContext", () => {
  it("prepends active video task guidance ahead of hook system context", () => {
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
      "Active task hint",
    );
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(
      "Music task hint",
    );

    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "user",
      hookPrependSystemContext: "Hook system context",
    });

    expect(
      videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession,
    ).toHaveBeenCalledWith("agent:main:discord:direct:123");
    expect(
      musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession,
    ).toHaveBeenCalledWith("agent:main:discord:direct:123");
    expect(result).toBe("Active task hint\n\nMusic task hint\n\nHook system context");
  });

  it("skips active video task guidance for non-user triggers", () => {
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReset();
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
      "Should not be used",
    );
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReset();
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(
      "Should not be used",
    );

    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "heartbeat",
      hookPrependSystemContext: "Hook system context",
    });

    expect(
      videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession,
    ).not.toHaveBeenCalled();
    expect(
      musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession,
    ).not.toHaveBeenCalled();
    expect(result).toBe("Hook system context");
  });
});

describe("resolvePromptSubmissionSkipReason", () => {
  it("skips empty prompt submissions without history or images", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [],
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("skips blank visible user prompt submissions even when replay history exists", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [{ role: "user", content: "previous turn", timestamp: 1 }],
        imageCount: 0,
      }),
    ).toBe("blank_user_prompt");
  });

  it("allows text or image prompt submissions", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "hello",
        messages: [],
        imageCount: 0,
      }),
    ).toBeNull();
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "   ",
        messages: [],
        imageCount: 1,
      }),
    ).toBeNull();
  });

  it("skips blank prompt on runtimeOnly turns", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "",
        messages: [],
        runtimeOnly: true,
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });

  it("treats undefined runtimeOnly as a visible user submission", () => {
    expect(
      resolvePromptSubmissionSkipReason({
        prompt: "",
        messages: [],
        runtimeOnly: undefined,
        imageCount: 0,
      }),
    ).toBe("empty_prompt_history_images");
  });
});

describe("resolveSuppressedCurrentUserTranscriptContext", () => {
  it("removes the eagerly persisted current user turn from model history", () => {
    const earlier = makeAgentAssistantMessage({
      content: [{ type: "text", text: "ready" }],
      timestamp: 1,
    });
    const eagerUser = makeAgentUserMessage({ content: "ship it", timestamp: 2 });

    const result = resolveSuppressedCurrentUserTranscriptContext({
      messages: [earlier, eagerUser],
      leafEntry: {
        type: "message",
        id: "entry-eager",
        message: eagerUser,
      },
      suppressNextUserMessagePersistence: true,
      suppressNextUserMessagePersistenceEntryId: "entry-eager",
    });

    expect(result.suppressed).toBe(true);
    expect(result.messages).toEqual([earlier]);
  });

  it("keeps history unchanged when the suppression entry id does not match the active leaf", () => {
    const eagerUser = makeAgentUserMessage({ content: "ship it", timestamp: 2 });

    const result = resolveSuppressedCurrentUserTranscriptContext({
      messages: [eagerUser],
      leafEntry: {
        type: "message",
        id: "entry-other",
        message: eagerUser,
      },
      suppressNextUserMessagePersistence: true,
      suppressNextUserMessagePersistenceEntryId: "entry-eager",
    });

    expect(result.suppressed).toBe(false);
    expect(result.messages).toEqual([eagerUser]);
  });

  it("keeps history unchanged when no eager transcript entry id is supplied", () => {
    const eagerUser = makeAgentUserMessage({ content: "ship it", timestamp: 2 });

    const result = resolveSuppressedCurrentUserTranscriptContext({
      messages: [eagerUser],
      leafEntry: {
        type: "message",
        id: "entry-eager",
        message: eagerUser,
      },
      suppressNextUserMessagePersistence: true,
    });

    expect(result.suppressed).toBe(false);
    expect(result.messages).toEqual([eagerUser]);
  });
});

describe("resolveTrailingUserPromptRepair", () => {
  it("repairs the older trailing user left after eager current-user suppression", () => {
    const earlier = makeAgentAssistantMessage({
      content: [{ type: "text", text: "ready" }],
      timestamp: 1,
    });
    const olderUser = makeAgentUserMessage({ content: "older active turn", timestamp: 2 });
    const eagerUser = makeAgentUserMessage({ content: "current inbound turn", timestamp: 3 });

    const suppressed = resolveSuppressedCurrentUserTranscriptContext({
      messages: [earlier, olderUser, eagerUser],
      leafEntry: {
        type: "message",
        id: "entry-eager",
        message: eagerUser,
      },
      suppressNextUserMessagePersistence: true,
      suppressNextUserMessagePersistenceEntryId: "entry-eager",
    });

    const repair = resolveTrailingUserPromptRepair({
      prompt: "current inbound turn",
      trigger: "user",
      messages: suppressed.messages,
    });

    expect(repair.repaired).toBe(true);
    expect(repair.merged).toBe(true);
    expect(repair.removeMessage).toBe(true);
    expect(repair.messages).toEqual([earlier]);
    expect(repair.prompt).toBe(
      "[Queued user message that arrived while the previous turn was still active]\n" +
        "older active turn\n\n" +
        "current inbound turn",
    );
  });

  it("leaves model history unchanged when it does not end with a user message", () => {
    const earlier = makeAgentAssistantMessage({
      content: [{ type: "text", text: "ready" }],
      timestamp: 1,
    });

    const repair = resolveTrailingUserPromptRepair({
      prompt: "current inbound turn",
      trigger: "user",
      messages: [earlier],
    });

    expect(repair).toEqual({
      prompt: "current inbound turn",
      messages: [earlier],
      repaired: false,
      merged: false,
      removeMessage: false,
    });
  });
});

describe("resolvePromptBuildHookResult drain cache", () => {
  it("drains plugin next-turn injections at most once per runId across retry attempts", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [
        {
          id: "inj-1",
          pluginId: "demo",
          text: "first attempt context",
          placement: "prepend_context",
          createdAt: 1,
        },
      ],
      prependContext: "first attempt context",
    });
    forgetPromptBuildDrainCacheForRun("run-cache-test");

    const hookCtx = { runId: "run-cache-test", sessionKey: "agent:main:main" };

    const first = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx,
    });
    const second = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx,
    });

    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);
    expect(first.prependContext).toBe("first attempt context");
    expect(second.prependContext).toBe("first attempt context");

    forgetPromptBuildDrainCacheForRun("run-cache-test");
  });

  it("re-drains after the run-scoped cache is forgotten", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValueOnce({
      queuedInjections: [],
      prependContext: undefined,
    });
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValueOnce({
      queuedInjections: [],
      prependContext: undefined,
    });

    const hookCtx = { runId: "run-evict-test", sessionKey: "agent:main:main" };

    await resolvePromptBuildHookResult({ config: {}, prompt: "hi", messages: [], hookCtx });
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);

    forgetPromptBuildDrainCacheForRun("run-evict-test");

    await resolvePromptBuildHookResult({ config: {}, prompt: "hi", messages: [], hookCtx });
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
  });

  it("drains every call when no runId is provided (no caching key)", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
      prependContext: undefined,
    });

    await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
    });
    await resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
    });

    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
  });
});
