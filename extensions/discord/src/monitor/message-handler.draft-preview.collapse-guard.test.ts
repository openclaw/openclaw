// Regression tests for the hasProgressDraftStarted latch + collapse guard
// introduced to fix #100782 while preserving the race-condition fix from
// commit 86ea382 ("fix(discord): preserve progress preview final edits").
//
// Background:
//   commit 86ea382 added a latch (progressDraftStartedBeforeFinal) that
//   snapshots hasStarted at markFinalReplyStarted() time. This prevents a
//   stuck progress bar when an abort cancels the compositor gate after the
//   final reply has already decided to collapse the draft.
//
//   However the latch was never cleared, so hasProgressDraftStarted remained
//   true permanently after markFinalReplyStarted(). In multi-tool turns
//   where multiple final payloads are delivered, shouldCollapseProgressDraft
//   would re-trigger collapse on an already-cleaned/sealed draft stream,
//   corrupting downstream delivery state and causing tool results to render
//   as image content blocks (#100782).
//
// Fix:
//   Add a progressDraftCollapsed guard set by markPreviewFinalized() that
//   prevents hasProgressDraftStarted from returning true after the draft has
//   already been collapsed into a summary. Reset the guard on
//   handleAssistantMessageBoundary() so followup/queued turns start fresh.
//
// Invariants under test:
//   1. Collapse guard: after markPreviewFinalized(), hasProgressDraftStarted
//      returns false, preventing re-collapse on subsequent final-payload
//      deliveries even when the compositor gate is still active.
//   2. New-turn reset: handleAssistantMessageBoundary() clears the guard so
//      the next turn's progress draft works correctly.
import { describe, expect, it } from "vitest";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

function buildController() {
  const replyRef = (() => {
    let id: string | undefined;
    return {
      peek: () => id,
      set: (v: string) => {
        id = v;
      },
    };
  })();

  return createDiscordDraftPreviewController({
    cfg: {} as Parameters<typeof createDiscordDraftPreviewController>[0]["cfg"],
    discordConfig: { streaming: { mode: "progress" as const } },
    accountId: "test-account",
    sourceRepliesAreToolOnly: false,
    textLimit: 2000,
    deliveryRest: {} as Parameters<typeof createDiscordDraftPreviewController>[0]["deliveryRest"],
    deliverChannelId: "test-channel",
    replyReference: replyRef as Parameters<
      typeof createDiscordDraftPreviewController
    >[0]["replyReference"],
    tableMode: "discord",
    maxLinesPerMessage: undefined,
    chunkMode: "discord",
    log: () => {},
  });
}

function toolLine(detail: string) {
  return {
    kind: "tool" as const,
    text: detail,
    label: detail,
    toolName: "exec",
    detail,
    status: "in_progress",
  };
}

// The compositor gate has a 5s initial-delay timer: the first noteWork()
// schedules the timer, the second triggers immediate start. This helper
// pushes two lines so the gate is started for tests that need it.
async function startGate(ctrl: ReturnType<typeof buildController>, detail = "running") {
  await ctrl.pushToolProgress(toolLine(`${detail} 1`));
  await ctrl.pushToolProgress(toolLine(`${detail} 2`));
}

describe("hasProgressDraftStarted latch + collapse guard", () => {
  it("returns false when no progress has started", () => {
    const ctrl = buildController();
    expect(ctrl.hasProgressDraftStarted).toBe(false);
  });

  it("returns true once the compositor gate is started", async () => {
    const ctrl = buildController();
    // Gate requires 2 work events to bypass the initial-delay timer.
    await startGate(ctrl);
    expect(ctrl.hasProgressDraftStarted).toBe(true);
  });

  it("latch preserves hasStarted after markFinalReplyStarted", async () => {
    const ctrl = buildController();
    await startGate(ctrl);
    expect(ctrl.hasProgressDraftStarted).toBe(true);

    ctrl.markFinalReplyStarted();
    // Gate is still active; latch captured gate=true at snapshot time.
    expect(ctrl.hasProgressDraftStarted).toBe(true);
  });

  // Core #100782 regression fix: collapse guard prevents re-collapse.
  it("collapse guard: hasProgressDraftStarted is false after markPreviewFinalized", async () => {
    const ctrl = buildController();
    await startGate(ctrl);
    ctrl.markFinalReplyStarted();
    ctrl.markPreviewFinalized();
    // After collapse: guard prevents re-collapse even though the gate is
    // still active (hasStarted=true because gate was never cancelled).
    expect(ctrl.hasProgressDraftStarted).toBe(false);
  });

  // Without the collapse guard, ||= would re-capture hasStarted=true from
  // the still-active gate each time markFinalReplyStarted() is called on a
  // subsequent final-payload delivery, causing shouldCollapseProgressDraft
  // to re-trigger on the now-cleaned stream.
  it("collapse guard survives repeated markFinalReplyStarted calls", async () => {
    const ctrl = buildController();
    await startGate(ctrl);
    ctrl.markFinalReplyStarted();
    ctrl.markPreviewFinalized();

    // Simulate second final-payload delivery in same turn.
    ctrl.markFinalReplyStarted();
    expect(ctrl.hasProgressDraftStarted).toBe(false);

    // Third call also must not flip it back.
    ctrl.markFinalReplyStarted();
    expect(ctrl.hasProgressDraftStarted).toBe(false);
  });

  it("new turn resets collapse guard so progress draft works again", async () => {
    const ctrl = buildController();

    // Turn 1: start → final → collapse.
    await startGate(ctrl, "turn1");
    ctrl.markFinalReplyStarted();
    ctrl.markPreviewFinalized();
    expect(ctrl.hasProgressDraftStarted).toBe(false);

    // New turn boundary: compositor beginNewTurn resets finalReplyStarted.
    ctrl.handleAssistantMessageBoundary();

    // Turn 2: a fresh progress draft.
    await startGate(ctrl, "turn2");
    expect(ctrl.hasProgressDraftStarted).toBe(true);

    ctrl.markFinalReplyStarted();
    expect(ctrl.hasProgressDraftStarted).toBe(true);

    ctrl.markPreviewFinalized();
    expect(ctrl.hasProgressDraftStarted).toBe(false);
  });

  it("returns false when no progress started and final reply delivered", () => {
    const ctrl = buildController();
    ctrl.markFinalReplyStarted();
    ctrl.markFinalReplyDelivered();
    expect(ctrl.hasProgressDraftStarted).toBe(false);
  });
});
