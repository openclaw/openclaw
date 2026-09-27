import type { APIMessageTopLevelComponent } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { serializePayload } from "./internal/discord.js";
import { buildDiscordMessageRequest } from "./send.message-request.js";

describe("buildDiscordMessageRequest", () => {
  it("omits create-message nonce fields from forum thread starters", () => {
    const body = buildDiscordMessageRequest({ endpoint: "forum-thread", text: "hello" });

    expect(body).toEqual({ content: "hello" });
  });

  it.each([
    { name: "content", content: "forbidden" },
    { name: "embeds", embeds: [{ title: "forbidden" }] },
  ])("rejects legacy $name alongside raw Components V2", ({ content, embeds }) => {
    const components: APIMessageTopLevelComponent[] = [
      { type: 17, components: [{ type: 10, content: "Choose an action" }] },
    ];

    expect(() => serializePayload({ content, embeds, components })).toThrow(
      "Discord Components V2 payloads cannot include content or embeds",
    );
  });
});
