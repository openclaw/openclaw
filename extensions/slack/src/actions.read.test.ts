import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages } from "./actions.js";

function createClient() {
  return {
    conversations: {
      replies: vi.fn(async () => ({ messages: [], has_more: false })),
      history: vi.fn(async () => ({ messages: [], has_more: false })),
    },
  } as unknown as WebClient & {
    conversations: {
      replies: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
  };
}

describe("readSlackMessages", () => {
  it("uses conversations.replies and drops the parent message", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890" }, { ts: "171235.000" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: undefined,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["171234.890", "171235.000"]);
  });

  it("filters a specific thread reply by messageId", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "171234.890", text: "reply" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      messageId: "171234.890",
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "reply" }],
      hasMore: false,
    });
  });

  it("uses conversations.history when threadId is missing", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1" }],
      has_more: false,
    });

    const result = await readSlackMessages("C1", {
      client,
      limit: 20,
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 20,
      latest: undefined,
      oldest: undefined,
    });
    expect(client.conversations.replies).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.ts)).toEqual(["1"]);
  });

  it("normalizes ISO read bounds with timezones before calling Slack history", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1778472000.000000" }],
      has_more: false,
    });

    await readSlackMessages("C1", {
      client,
      after: "2026-05-11T04:00:00Z",
      before: "2026-05-11T01:30:00-04:00",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1778477400",
      oldest: "1778472000",
    });
  });

  it("preserves Slack timestamp read bounds", async () => {
    const client = createClient();

    await readSlackMessages("C1", {
      client,
      after: "1712345678.123456",
      before: "1712349999",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1712349999",
      oldest: "1712345678.123456",
    });
  });

  it("rejects unrecognized read bounds instead of silently falling back", async () => {
    const client = createClient();

    await expect(
      readSlackMessages("C1", {
        client,
        after: "yesterday morning",
        token: "xoxb-test",
      }),
    ).rejects.toThrow(
      "Invalid Slack message read after value: expected a Slack timestamp, Unix epoch seconds, or ISO 8601 timestamp with timezone.",
    );
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it.each(["05/11/2026", "May 11, 2026 04:00", "2026-05-11T04:00:00"])(
    "rejects ambiguous or timezone-less read bound %s",
    async (after) => {
      const client = createClient();

      await expect(
        readSlackMessages("C1", {
          client,
          after,
          token: "xoxb-test",
        }),
      ).rejects.toThrow(
        "Invalid Slack message read after value: expected a Slack timestamp, Unix epoch seconds, or ISO 8601 timestamp with timezone.",
      );
      expect(client.conversations.history).not.toHaveBeenCalled();
      expect(client.conversations.replies).not.toHaveBeenCalled();
    },
  );

  it("normalizes ISO read bounds with timezones before calling Slack replies", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts: "171234.567" }, { ts: "1778472000.000000" }],
      has_more: false,
    });

    await readSlackMessages("C1", {
      client,
      threadId: "171234.567",
      after: "2026-05-11T04:00:00Z",
      before: "2026-05-11T05:30:00Z",
      token: "xoxb-test",
    });

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "171234.567",
      limit: undefined,
      latest: "1778477400",
      oldest: "1778472000",
    });
  });

  it("filters a specific channel message by messageId", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "171234.890", text: "exact" }, { ts: "171234.891" }],
      has_more: true,
    });

    const result = await readSlackMessages("C1", {
      client,
      messageId: "171234.890",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: 1,
      inclusive: true,
      latest: "171234.890",
      oldest: undefined,
    });
    expect(result).toEqual({
      messages: [{ ts: "171234.890", text: "exact" }],
      hasMore: false,
    });
  });
});
