import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackMessages } from "./actions.js";

const createSlackLookupClientMock = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({
  createSlackLookupClient: createSlackLookupClientMock,
  getSlackWriteClient: vi.fn(),
}));
function createClient() {
  return {
    conversations: { replies: vi.fn(), history: vi.fn() },
  } as unknown as WebClient & {
    conversations: { replies: ReturnType<typeof vi.fn>; history: ReturnType<typeof vi.fn> };
  };
}
type Bounds = { oldest?: string; latest?: string; inclusive?: boolean; limit?: number };
function threadClient() {
  const client = createClient();
  const messages = Array.from({ length: 102 }, (_, index) => ({
    ts: "171234." + String(index).padStart(6, "0"),
    text: index === 101 ? "requested reply" : "message " + String(index),
  }));
  client.conversations.replies.mockImplementation(
    ({ oldest, latest, inclusive, limit }: Bounds) => {
      const eligible = messages.filter(
        (message) =>
          (!oldest || message.ts > oldest || (inclusive && message.ts === oldest)) &&
          (!latest || message.ts < latest || (inclusive && message.ts === latest)),
      );
      return { messages: eligible.slice(0, limit), has_more: eligible.length > (limit ?? 0) };
    },
  );
  return client;
}

describe("Slack read actions", () => {
  it("excludes the parent before applying the thread page limit", async () => {
    const client = threadClient();
    await expect(
      readSlackMessages("C1", {
        client,
        threadId: "171234.000000",
        after: "171233.000000",
        limit: 1,
      }),
    ).resolves.toEqual({
      messages: [{ ts: "171234.000001", text: "message 1" }],
      hasMore: true,
    });
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("reads an exact reply beyond the first thread page", async () => {
    const client = threadClient();
    await expect(
      readSlackMessages("C1", {
        client,
        threadId: "171234.000000",
        messageId: "171234.000101",
        limit: 20,
      }),
    ).resolves.toEqual({
      messages: [{ ts: "171234.000101", text: "requested reply" }],
      hasMore: false,
    });
    expect(client.conversations.replies).toHaveBeenCalledExactlyOnceWith({
      channel: "C1",
      ts: "171234.000000",
      limit: 1,
      inclusive: true,
      oldest: "171234.000101",
      latest: "171234.000101",
    });
  });

  it("reads ISO-bounded channel history through the lookup client and preserves table payloads", async () => {
    const client = createClient();
    const blocks = [
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "ID" },
            { type: "raw_text", text: "Status" },
          ],
          [
            { type: "raw_number", value: 12345 },
            { type: "raw_text", text: "enabled" },
          ],
        ],
      },
    ];
    const attachments = [{ fallback: "[no preview available]", blocks }];
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1", text: "  Please check these.  ", attachments }],
      has_more: false,
    });
    createSlackLookupClientMock.mockReturnValueOnce(client);
    const result = await readSlackMessages("C1", {
      token: "test-auth-token",
      cfg: { channels: { slack: { enabled: true, botToken: "test-auth-token" } } },
      before: "2024-04-05T12:34:56+03:00",
      after: "2024-04-05T12:34:56.789+03:00",
    });
    expect(createSlackLookupClientMock).toHaveBeenCalledWith(
      "test-auth-token",
      { teamId: undefined },
      undefined,
    );
    expect(client.conversations.history).toHaveBeenCalledExactlyOnceWith({
      channel: "C1",
      limit: undefined,
      latest: "1712309696",
      oldest: "1712309696.789",
    });
    expect(result.messages[0]?.text).toBe("  Please check these.  \nID\tStatus\n12345\tenabled");
    expect(result.messages[0]?.attachments).toBe(attachments);
    expect(result.messages[0]?.attachments?.[0]?.blocks).toBe(blocks);
    expect(result.hasMore).toBe(false);
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("unwraps JSON-escaped Slack timestamp strings before applying history bounds", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({ messages: [], has_more: false });

    await readSlackMessages("C1", {
      client,
      before: '"1712345678.654321"',
      after: '"1712340000.000001"',
    });

    expect(client.conversations.history).toHaveBeenCalledExactlyOnceWith({
      channel: "C1",
      limit: undefined,
      latest: "1712345678.654321",
      oldest: "1712340000.000001",
    });
  });

  it("unwraps JSON-escaped ISO date strings before applying history bounds", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValueOnce({ messages: [], has_more: false });

    await readSlackMessages("C1", {
      client,
      before: '"2024-04-05T12:34:56.000Z"',
    });

    expect(client.conversations.history).toHaveBeenCalledExactlyOnceWith({
      channel: "C1",
      limit: undefined,
      latest: "1712320496",
      oldest: undefined,
    });
  });

  it("rejects a JSON-escaped value that is still not a valid history bound", async () => {
    const client = createClient();

    await expect(
      readSlackMessages("C1", {
        client,
        before: '"not-a-timestamp"',
      }),
    ).rejects.toThrow(
      `Invalid Slack read before timestamp "not-a-timestamp": expected a Slack timestamp or ISO-8601 date string`,
    );
    expect(client.conversations.history).not.toHaveBeenCalled();
  });

  it("keeps explicit reply bounds after the parent and drops an echoed root", async () => {
    const client = createClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [
        { ts: "1.000", text: "parent" },
        { ts: "1.001", text: "reply" },
      ],
      has_more: false,
    });
    await expect(
      readSlackMessages("C1", {
        client,
        threadId: "1.000",
        before: "2.000001",
        after: "1.000001",
      }),
    ).resolves.toEqual({ messages: [{ ts: "1.001", text: "reply" }], hasMore: false });
    expect(client.conversations.replies).toHaveBeenCalledExactlyOnceWith({
      channel: "C1",
      ts: "1.000",
      limit: undefined,
      latest: "2.000001",
      oldest: "1.000001",
    });
  });

  it("rejects invalid history bounds before Slack API work", async () => {
    const client = createClient();
    await expect(
      readSlackMessages("C1", { client, before: "2024-02-30T00:00:00.000Z" }),
    ).rejects.toThrow(
      'Invalid Slack read before timestamp "2024-02-30T00:00:00.000Z": expected a Slack timestamp or ISO-8601 date string',
    );
    expect(client.conversations.history).not.toHaveBeenCalled();
  });
});
