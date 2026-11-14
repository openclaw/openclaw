import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as nativeAnchor from "../../config/sessions/session-accessor.sqlite-transcript-admitted-read.js";
import * as transcriptAnchor from "../../config/sessions/session-transcript-anchor-read.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
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
import { bindAgentHarnessHookMessages, takeHookMessageLoader } from "./lifecycle-hook-messages.js";

vi.mock("./lifecycle-hook-helpers.js", () => ({
  awaitAgentHarnessAgentEndHook: vi.fn(),
  runAgentHarnessAgentEndHook: vi.fn(),
}));

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
    completedTurnSource: reviewSource,
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
  mockAwaitAgentEndHook.mockReset();
  mockRunAgentEndHook.mockReset();
});

it("hands hooks an append receipt without rereading it and refuses a revoked writer", async () => {
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
      completedTurnSource: { ...target, entryId: appended.entryId },
    } satisfies Parameters<typeof runAgentEndSideEffectsAsync>[0];
    await runAgentEndSideEffectsAsync(params);
    expect(mockRunAgentEndHook.mock.calls[0]?.[0].ctx.completedTurn).toEqual({
      sessionId: anchor?.sessionId,
      entryId: anchor?.entryId,
    });
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
    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(2);
    // A revoked writer's turn gives hooks no completed turn to fork.
    expect(mockRunAgentEndHook.mock.calls[1]?.[0].ctx.completedTurn).toBeUndefined();
  });
});

it.each(["sdk", "bundled"] as const)(
  "prepares the completed turn before %s plugin hooks",
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
      read.resolve(reviewSource);
      await completion;
    } else {
      expect(runAgentEndSideEffects(params)).toBeUndefined();
    }
    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(1);
    expect(mockRunAgentEndHook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: expect.objectContaining({
          skillsUsed: [{ name: "release-runbook", source: "workspace", activation: "read" }],
        }),
        ctx: expect.objectContaining({
          completedTurn: { sessionId: "session-1", entryId: "completed-message" },
        }),
      }),
    );
  },
);

it.each(["anchor read", "CLI context"])("still runs agent_end hooks with %s", async (phase) => {
  if (phase !== "CLI context") {
    vi.mocked(transcriptAnchor.readActiveTranscriptEntryAnchorAsync).mockImplementationOnce(() => {
      throw new Error(`${phase} failed`);
    });
  }
  const params = sideEffectParams();
  if (phase === "CLI context") {
    delete params.completedTurnSource;
    params.ctx = { runId: "run-1", workspaceDir: "/workspace" };
  }
  await awaitAgentEndSideEffects(params);

  expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
  // A turn whose anchor could not be read gives hooks no completed turn to fork.
  expect(mockAwaitAgentEndHook.mock.calls[0]?.[0].ctx.completedTurn).toBeUndefined();
});

it("gives plugin hooks the run's skills, iterations and tool names, keeping the message loader", async () => {
  recordRunSkillUsage({ runId: "run-1", name: "deploy", source: "workspace", activation: "read" });
  const loadMessages = async () => [{ role: "assistant", content: "full" }];
  const params = sideEffectParams();
  params.event = bindAgentHarnessHookMessages(
    { ...params.event, modelIterations: 3 },
    loadMessages,
  );
  params.ctx = { ...params.ctx, toolNames: ["read", "skill_workshop"] };

  await awaitAgentEndSideEffects(params);

  const hook = mockAwaitAgentEndHook.mock.calls[0]?.[0];
  expect(hook?.event).toMatchObject({
    modelIterations: 3,
    skillsUsed: [{ name: "deploy", source: "workspace", activation: "read" }],
  });
  expect(hook?.ctx.toolNames).toEqual(["read", "skill_workshop"]);
  expect(hook?.ctx.completedTurn).toEqual({ sessionId: "session-1", entryId: "completed-message" });
  // Hooks still hydrate the full transcript evidence bound by the runtime.
  expect(takeHookMessageLoader(hook!.event)).toBe(loadMessages);
});

it("leaves an unknown model-call count off the plugin event", async () => {
  const params = sideEffectParams();
  params.event = { ...params.event, modelIterations: undefined };

  await awaitAgentEndSideEffects(params);

  expect(mockAwaitAgentEndHook.mock.calls[0]?.[0].event).not.toHaveProperty("modelIterations");
});

it("maps the retired SDK context fields onto their public replacements", async () => {
  const params = sideEffectParams();
  params.ctx = { ...params.ctx, modelIterations: 4, skillWorkshopAvailable: true };

  await awaitAgentEndSideEffects(params);

  const hook = mockAwaitAgentEndHook.mock.calls[0]?.[0];
  expect(hook?.event.modelIterations).toBe(4);
  expect(hook?.ctx.toolNames).toEqual(["skill_workshop"]);
  expect(hook?.ctx).not.toHaveProperty("modelIterations");
  expect(hook?.ctx).not.toHaveProperty("skillWorkshopAvailable");
});

it("accepts the retired review source as the completed turn", async () => {
  const { completedTurnSource, ...params } = sideEffectParams();

  await awaitAgentEndSideEffects({ ...params, skillExperienceReviewSource: completedTurnSource });

  const hook = mockAwaitAgentEndHook.mock.calls[0]?.[0];
  expect(hook?.ctx.completedTurn).toEqual({ sessionId: "session-1", entryId: "completed-message" });
  expect(hook).not.toHaveProperty("skillExperienceReviewSource");
});
