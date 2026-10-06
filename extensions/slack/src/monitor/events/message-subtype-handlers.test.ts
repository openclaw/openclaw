// Slack tests cover message subtype handlers plugin behavior.
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";

describe("resolveSlackMessageSubtypeHandler", () => {
  it("resolves message_changed metadata and identifiers", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: "D1",
      event_ts: "123.456",
      message: { ts: "123.456", user: "U1" },
      previous_message: { ts: "123.450", user: "U2" },
    } as unknown as SlackMessageEvent;

    const handler = resolveSlackMessageSubtypeHandler(event);
    expect(handler?.eventKind).toBe("message_changed");
    expect(handler?.resolveSenderId(event)).toBe("U1");
    expect(handler?.contextKey(event)).toBe("slack:message:changed:D1:123.456");
    expect(handler?.describe("DM with @user")).toContain("edited");
  });
});
