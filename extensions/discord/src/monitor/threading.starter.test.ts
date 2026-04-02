import { ChannelType, type Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDiscordThreadStarterCacheForTest,
  resolveDiscordThreadStarter,
} from "./threading.js";

async function resolveStarter(
  message: Partial<Awaited<ReturnType<Client["rest"]["get"]>>>,
  resolveTimestampMs: () => number | undefined,
) {
  const get = vi.fn().mockResolvedValue(message);
  const client = { rest: { get } } as unknown as Client;

  return resolveDiscordThreadStarter({
    channel: { id: "thread-1" },
    client,
    parentId: "parent-1",
    parentType: ChannelType.GuildText,
    resolveTimestampMs,
  });
}

describe("resolveDiscordThreadStarter", () => {
  beforeEach(() => {
    __resetDiscordThreadStarterCacheForTest();
  });

  it("falls back to joined embed title and description when content is empty", async () => {
    const result = await resolveStarter(
      {
        content: "   ",
        embeds: [{ title: "Alert", description: "Details" }],
        author: { id: "u1", username: "Alice", discriminator: "0" },
        timestamp: "2026-02-24T12:00:00.000Z",
      },
      () => 123,
    );

    expect(result).toMatchObject({
      text: "Alert\nDetails",
      author: "Alice",
      authorId: "u1",
      timestamp: 123,
    });
  });

  it("prefers starter content over embed fallback text", async () => {
    const result = await resolveStarter(
      {
        content: "starter content",
        embeds: [{ title: "Alert", description: "Details" }],
        author: { username: "Alice", discriminator: "0" },
      },
      () => undefined,
    );

    if (!result) {
      throw new Error("starter content should have produced a resolved starter payload");
    }
    expect(result.text).toBe("starter content");
  });

  it("preserves username, tag, and role metadata for downstream visibility checks", async () => {
    const result = await resolveStarter(
      {
        content: "starter content",
        author: { id: "u1", username: "Alice", discriminator: "1234" },
        member: {
          roles: ["role-1", "role-2"],
        },
      } as never,
      () => undefined,
    );

    expect(result).toMatchObject({
      author: "Alice#1234",
      authorId: "u1",
      authorName: "Alice",
      authorTag: "Alice#1234",
      memberRoleIds: ["role-1", "role-2"],
    });
  });
});
