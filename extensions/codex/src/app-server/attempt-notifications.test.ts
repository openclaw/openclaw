import { describe, expect, it } from "vitest";
import { isRawToolOutputCompletionNotification } from "./attempt-notifications.js";
import type { CodexServerNotification } from "./protocol.js";

function rawResponseItemCompleted(itemType: string): CodexServerNotification {
  return {
    method: "rawResponseItem/completed",
    params: { item: { type: itemType, id: "item-1" } },
  };
}

describe("isRawToolOutputCompletionNotification", () => {
  it("recognizes custom_tool_call_output completions", () => {
    expect(
      isRawToolOutputCompletionNotification(rawResponseItemCompleted("custom_tool_call_output")),
    ).toBe(true);
  });

  it("recognizes image_generation_call completions so the idle watchdog does not retire the turn", () => {
    expect(
      isRawToolOutputCompletionNotification(rawResponseItemCompleted("image_generation_call")),
    ).toBe(true);
  });

  it("ignores unrelated raw response item types", () => {
    expect(isRawToolOutputCompletionNotification(rawResponseItemCompleted("message"))).toBe(false);
  });

  it("ignores items without a recognized type or non-object params", () => {
    expect(isRawToolOutputCompletionNotification(rawResponseItemCompleted(""))).toBe(false);
    expect(isRawToolOutputCompletionNotification({ method: "rawResponseItem/completed" })).toBe(
      false,
    );
  });

  it("ignores other notification methods", () => {
    expect(
      isRawToolOutputCompletionNotification({
        method: "turn/completed",
        params: { item: { type: "image_generation_call" } },
      }),
    ).toBe(false);
  });
});
