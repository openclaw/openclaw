// Codex tests cover the attempt notification-state turn watchdog wiring.
import { describe, expect, it, vi } from "vitest";
import { applyCodexTurnNotificationState } from "./attempt-notification-state.js";
import type { CodexAttemptTurnWatchController } from "./attempt-turn-watches.js";
import type { CodexServerNotification } from "./protocol.js";

type TouchActivityCall = {
  reason: string;
  options?: {
    arm?: boolean;
    details?: Record<string, unknown>;
    attemptProgress?: boolean;
    attemptTimeoutMs?: number;
  };
};

function createTurnWatchStub() {
  const touchActivityCalls: TouchActivityCall[] = [];
  const controller = {
    isCompletionIdleWatchArmed: () => false,
    isCompletionIdleWatchPinnedByTerminalError: () => false,
    isAssistantCompletionIdleWatchArmed: () => false,
    armAttemptIdleWatch: vi.fn(),
    armTerminalIdleWatch: vi.fn(),
    armCompletionIdleWatch: vi.fn(),
    disarmCompletionIdleWatch: vi.fn(),
    armAssistantCompletionIdleWatch: vi.fn(),
    disarmAssistantCompletionIdleWatch: vi.fn(),
    touchActivity: (reason: string, options?: TouchActivityCall["options"]) => {
      touchActivityCalls.push({ reason, options });
    },
    noteNotificationReceived: vi.fn(),
    extendAttemptIdleWatch: vi.fn(),
    scheduleProgressWatches: vi.fn(),
    clearCompletionIdleTimer: vi.fn(),
    clearAssistantCompletionIdleTimer: vi.fn(),
    clearTerminalIdleTimer: vi.fn(),
    clearAttemptIdleTimer: vi.fn(),
    clearAllTimers: vi.fn(),
  } as unknown as CodexAttemptTurnWatchController;
  return { controller, touchActivityCalls };
}

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

function applyNotification(
  notification: CodexServerNotification,
  turnWatches: CodexAttemptTurnWatchController,
) {
  return applyCodexTurnNotificationState({
    notification,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    currentPromptTexts: [],
    turnWatches,
    activeTurnItemIds: new Set<string>(),
    activeCompletionBlockerItemIds: new Set<string>(),
    activeAppServerTurnRequests: 0,
    pendingOpenClawDynamicToolCompletionIds: new Set<string>(),
    turnCrossedToolHandoff: false,
    postToolRawAssistantCompletionIdleTimeoutMs: 60_000,
    onScheduleTerminalDynamicToolReleaseCheck: () => {},
    onReportExecutionNotification: () => {},
  });
}

describe("applyCodexTurnNotificationState accepted-turn watchdog", () => {
  it("keeps accepted turns on the configured attempt timeout before item progress", () => {
    const { controller, touchActivityCalls } = createTurnWatchStub();

    const result = applyNotification(
      { method: "turn/started", params: { threadId: THREAD_ID, turnId: TURN_ID } },
      controller,
    );

    expect(result.isCurrentTurnNotification).toBe(true);
    expect(touchActivityCalls).toHaveLength(1);
    expect(touchActivityCalls[0]?.reason).toBe("notification:turn/started");
    expect(touchActivityCalls[0]?.options).toMatchObject({
      attemptProgress: true,
    });
    expect(touchActivityCalls[0]?.options?.attemptTimeoutMs).toBeUndefined();
  });

  it("reverts to the full attempt timeout once item-level progress arrives", () => {
    const { controller, touchActivityCalls } = createTurnWatchStub();

    applyNotification(
      { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID } },
      controller,
    );

    expect(touchActivityCalls).toHaveLength(1);
    expect(touchActivityCalls[0]?.reason).toBe("notification:item/started");
    expect(touchActivityCalls[0]?.options?.attemptProgress).toBe(true);
    expect(touchActivityCalls[0]?.options?.attemptTimeoutMs).toBeUndefined();
  });

  it("ignores notifications for a different turn", () => {
    const { controller, touchActivityCalls } = createTurnWatchStub();

    const result = applyNotification(
      { method: "turn/started", params: { threadId: THREAD_ID, turnId: "other-turn" } },
      controller,
    );

    expect(result.isCurrentTurnNotification).toBe(false);
    expect(touchActivityCalls).toHaveLength(0);
  });
});
