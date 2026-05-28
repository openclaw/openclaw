import { describe, expect, it } from "vitest";
import { describeNotificationActivity } from "./attempt-notifications.js";

describe("Codex app-server attempt notifications", () => {
  it("describes completed item activity for timeout diagnostics", () => {
    expect(
      describeNotificationActivity({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "dynamicToolCall",
            tool: "sessions_list",
            status: "completed",
          },
        },
      }),
    ).toEqual({
      lastNotificationMethod: "item/completed",
      lastNotificationItemId: "tool-1",
      lastNotificationItemType: "dynamicToolCall",
      lastNotificationItemRole: undefined,
      lastNotificationItemStatus: "completed",
      lastNotificationTool: "sessions_list",
    });
  });
});
