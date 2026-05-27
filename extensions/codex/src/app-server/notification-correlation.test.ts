import { describe, expect, it } from "vitest";
import {
  describeCodexNotificationCorrelation,
  isCodexNotificationForTurn,
} from "./notification-correlation.js";
import type { CodexServerNotification } from "./protocol.js";

function defineThrowingProperty(target: object, key: string, message: string): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
}

describe("isCodexNotificationForTurn", () => {
  it("ignores unreadable synthetic routing fields without throwing", () => {
    const params = { turnId: "turn-1" };
    defineThrowingProperty(params, "threadId", "fuzzplugin notification read failed");

    expect(isCodexNotificationForTurn(params, "thread-1", "turn-1")).toBe(false);
  });
});

describe("describeCodexNotificationCorrelation", () => {
  it("summarizes unreadable synthetic notification fields without throwing", () => {
    const params = { turnId: "turn-1" };
    defineThrowingProperty(params, "threadId", "fuzzplugin notification read failed");
    const notification = {
      method: "item/agentMessage/delta",
      params,
    } as unknown as CodexServerNotification;

    const correlation = describeCodexNotificationCorrelation(notification, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(correlation).toMatchObject({
      activeThreadId: "thread-1",
      activeTurnId: "turn-1",
      matchesActiveThread: false,
      matchesActiveTurn: false,
      method: "item/agentMessage/delta",
      paramsKeys: ["threadId", "turnId"],
      turnId: "turn-1",
    });
  });

  it("omits unreadable synthetic nested turn fields without throwing", () => {
    const turn = { id: "turn-1" };
    defineThrowingProperty(turn, "threadId", "fuzzplugin nested turn read failed");
    const params = {
      threadId: "thread-1",
      turn,
    };
    const notification = {
      method: "turn/completed",
      params,
    } as unknown as CodexServerNotification;

    const correlation = describeCodexNotificationCorrelation(notification, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(correlation).toMatchObject({
      activeThreadId: "thread-1",
      activeTurnId: "turn-1",
      matchesActiveThread: true,
      matchesActiveTurn: true,
      method: "turn/completed",
      nestedTurnId: "turn-1",
      threadId: "thread-1",
    });
    expect(correlation).not.toHaveProperty("nestedTurnThreadId");
  });
});
