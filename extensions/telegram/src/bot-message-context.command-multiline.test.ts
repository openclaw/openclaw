// Telegram tests cover multiline text-directive command projection at ingress.
import { describe, expect, it } from "vitest";

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

function directMessage(text: string) {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 42, type: "private" as const, first_name: "Pat" },
    from: { id: 42, first_name: "Pat" },
    text,
    entities: [{ type: "bot_command" as const, offset: 0, length: text.indexOf("\n") }],
  };
}

async function buildCommandBody(text: string) {
  const ctx = await buildTelegramMessageContextForTest({ message: directMessage(text) });
  return ctx?.ctxPayload?.CommandBody;
}

describe("Telegram ingress multiline command projection", () => {
  it("preserves the task tail of a multiline text directive", async () => {
    expect(await buildCommandBody("/think high\nsummarize the release notes")).toBe(
      "/think high\nsummarize the release notes",
    );
  });

  it("preserves the tail raw for /reset so core keeps ownership of flattening", async () => {
    expect(await buildCommandBody("/reset\nkeep this line")).toBe("/reset\nkeep this line");
  });

  it("still canonicalizes text aliases on the command line", async () => {
    expect(await buildCommandBody("/t high\nsummarize the release notes")).toBe(
      "/think high\nsummarize the release notes",
    );
  });

  it("leaves single-line commands unchanged", async () => {
    expect(await buildCommandBody("/think high")).toBe("/think high");
  });
});
