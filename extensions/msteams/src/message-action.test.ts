import { describe, expect, it } from "vitest";
import {
  buildMessageActionPrompt,
  extractMessageActionText,
  isMessageActionInvoke,
  MSTEAMS_ASK_OPENCLAW_COMMAND,
  type MSTeamsMessageActionValue,
} from "./message-action.js";

describe("message-action (#10)", () => {
  const value = (content?: string, author?: string): MSTeamsMessageActionValue => ({
    commandId: MSTEAMS_ASK_OPENCLAW_COMMAND,
    commandContext: "message",
    messagePayload: {
      body: content === undefined ? undefined : { content },
      from: author ? { user: { displayName: author } } : undefined,
    },
  });

  it("extracts and sanitizes the selected message text", () => {
    expect(extractMessageActionText(value("<p>Hello <b>world</b></p>"))).toBe("Hello world");
    expect(extractMessageActionText(value("<at>Bob</at> please review"))).toBe(
      "@Bob please review",
    );
  });

  it("returns undefined for empty / card-only / missing payloads", () => {
    expect(extractMessageActionText(value("   "))).toBeUndefined();
    expect(extractMessageActionText(value(undefined))).toBeUndefined();
    expect(extractMessageActionText(undefined)).toBeUndefined();
  });

  it("builds a prompt that quotes the message and attributes the author", () => {
    const prompt = buildMessageActionPrompt(value("ship the release on friday", "Sara"));
    expect(prompt).toContain("Ask OpenClaw about this");
    expect(prompt).toContain("from Sara");
    expect(prompt).toContain("ship the release on friday");
  });

  it("produces no prompt when there is nothing to act on", () => {
    expect(buildMessageActionPrompt(value(""))).toBeUndefined();
  });

  it("recognizes the message-action invoke by command id or message context", () => {
    expect(isMessageActionInvoke(value("x"))).toBe(true);
    expect(isMessageActionInvoke({ commandContext: "message" })).toBe(true);
    expect(isMessageActionInvoke({ commandId: "other", commandContext: "compose" })).toBe(false);
    expect(isMessageActionInvoke(undefined)).toBe(false);
  });
});
