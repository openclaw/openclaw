import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as nativeAnchor from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import * as transcriptAnchor from "../../config/sessions/session-transcript-anchor-read.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withSessionTranscriptWriteAssertion,
} from "../../config/sessions/transcript-write-context.js";
import { recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { scheduleSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  completedTurnMessageAnchor,
  captureCompletedTurnMessageAnchor,
  sessionManagerReadMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
  runAgentEndSideEffectsAsync,
} from "./agent-end-side-effects.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

// mock-isolation: Capture workshop scheduling without running background experience reviews.
vi.mock("../../skills/workshop/experience-review-default.js", () => ({
  scheduleSkillExperienceReview: vi.fn(),
  scheduleUnusedWorkshopSkillArchive: vi.fn(),
}));

vi.mock("./lifecycle-hook-helpers.js", () => ({
  awaitAgentHarnessAgentEndHook: vi.fn(),
  runAgentHarnessAgentEndHook: vi.fn(),
}));

const mockExperienceReview = vi.mocked(scheduleSkillExperienceReview);
const mockAwaitAgentEndHook = vi.mocked(awaitAgentHarnessAgentEndHook);
const mockRunAgentEndHook = vi.mocked(runAgentHarnessAgentEndHook);
const reviewSource = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:main",
  storePath: "/session-store",
  entryId: "completed-message",
  generation: "generation-1",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
};
function sideEffectParams(): Parameters<typeof runAgentEndSideEffects>[0] {
  return {
    skillExperienceReviewSource: reviewSource,
    event: { messages: [], success: true },
    ctx: {
      runId: "run-1",
      workspaceDir: "/workspace",
      config: {},
      foregroundPromptContext: {
        agentId: "main",
        workspaceDir: "/workspace",
        sandboxSessionKey: "agent:main:main",
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(nativeAnchor, "readActiveTranscriptEntryAnchor").mockReturnValue(reviewSource);
  vi.spyOn(transcriptAnchor, "readActiveTranscriptEntryAnchorAsync").mockResolvedValue(
    reviewSource,
  );
  mockExperienceReview.mockReset();
  mockAwaitAgentEndHook.mockReset();
  mockRunAgentEndHook.mockReset();
});

it("schedules an append receipt without rereading it and refuses a revoked writer", async () => {
  await withOpenClawTestState({ label: "agent-end-append-receipt" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "receipt",
      sessionKey: "agent:main:receipt",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target);
    const appended = await manager.appendMessageWithTranscriptAnchorAsync({
      role: "user",
      content: "completed turn",
      timestamp: 1,
    });
    const anchor = manager[sessionManagerReadMessageAnchor](appended.entryId);
    expect(anchor).toEqual(appended.anchor);
    const params = {
      ...sideEffectParams(),
      [completedTurnMessageAnchor]: captureCompletedTurnMessageAnchor(manager, appended.entryId),
      skillExperienceReviewSource: { ...target, entryId: appended.entryId },
    } satisfies Parameters<typeof runAgentEndSideEffectsAsync>[0];
    await runAgentEndSideEffectsAsync(params);
    expect(mockExperienceReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: anchor }),
    );
    expect(transcriptAnchor.readActiveTranscriptEntryAnchorAsync).not.toHaveBeenCalled();
    const writer = new AbortController();
    await withSessionTranscriptWriteAssertion(
      target,
      () => writer.signal.throwIfAborted(),
      async () => {
        const receipt = captureCompletedTurnMessageAnchor(manager, appended.entryId);
        writer.abort(new Error("writer revoked"));
        await runWithoutOwnedSessionTranscriptWrites(() =>
          runAgentEndSideEffectsAsync({ ...params, [completedTurnMessageAnchor]: receipt }),
        );
      },
    );
    expect(mockExperienceReview).toHaveBeenCalledOnce();
    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(2);
  });
});

it.each(["sdk", "bundled"] as const)(
  "prepares the experience review before %s plugin hooks",
  async (mode) => {
    const read = createDeferred<typeof reviewSource>();
    vi.mocked(transcriptAnchor.readActiveTranscriptEntryAnchorAsync).mockReturnValueOnce(
      read.promise,
    );
    recordRunSkillUsage({
      runId: "run-1",
      name: "release-runbook",
      source: "workspace",
      activation: "read",
    });
    const params = sideEffectParams();

    if (mode === "bundled") {
      const completion = runAgentEndSideEffectsAsync(params);
      expect(mockRunAgentEndHook).not.toHaveBeenCalled();
      expect(mockExperienceReview).not.toHaveBeenCalled();
      read.resolve(reviewSource);
      await completion;
    } else {
      expect(runAgentEndSideEffects(params)).toBeUndefined();
    }
    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(1);
    expect(mockExperienceReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        usedSkills: [{ name: "release-runbook", source: "workspace", activation: "read" }],
        source: reviewSource,
      }),
    );
  },
);

it.each(["scheduling", "anchor read", "CLI context"])(
  "still runs agent_end hooks with %s",
  async (phase) => {
    if (phase !== "CLI context") {
      const fail =
        phase === "scheduling"
          ? mockExperienceReview
          : vi.mocked(transcriptAnchor.readActiveTranscriptEntryAnchorAsync);
      fail.mockImplementationOnce(() => {
        throw new Error(`${phase} failed`);
      });
    }
    const params = sideEffectParams();
    if (phase === "CLI context") {
      delete params.skillExperienceReviewSource;
      params.ctx = { runId: "run-1", workspaceDir: "/workspace" };
    }
    await awaitAgentEndSideEffects(params);

    expect(mockExperienceReview).toHaveBeenCalledTimes(phase === "scheduling" ? 1 : 0);
    expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
  },
);
