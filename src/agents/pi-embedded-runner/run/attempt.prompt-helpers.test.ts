import { describe, expect, it, vi } from "vitest";

const musicGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(),
}));

const videoGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(),
}));

vi.mock("../../music-generation-task-status.js", () => musicGenerationTaskStatusMocks);
vi.mock("../../video-generation-task-status.js", () => videoGenerationTaskStatusMocks);

import { resolveAttemptPrependSystemContext } from "./attempt.prompt-helpers.js";

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
