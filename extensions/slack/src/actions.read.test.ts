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

  it("normalizes ISO 8601 `after` to Slack epoch-seconds ts", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1778500800.123456" }],
      has_more: false,
    });

    await readSlackMessages("C1", {
      client,
      after: "2026-05-11T12:00:00Z",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: undefined,
      oldest: "1778500800.000",
    });
  });

  it("normalizes ISO 8601 `before` to Slack epoch-seconds ts", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [],
      has_more: false,
    });

    await readSlackMessages("C1", {
      client,
      before: "2026-05-11T08:00:00-04:00",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1778500800.000",
      oldest: undefined,
    });
  });

  it("preserves plain numeric timestamps unchanged", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1778500800.000000" }],
      has_more: false,
    });

    await readSlackMessages("C1", {
      client,
      after: "1746936000",
      before: "1747108800.123",
      token: "xoxb-test",
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C1",
      limit: undefined,
      latest: "1747108800.123",
      oldest: "1746936000",
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
