import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let searchMessagesMSTeams: GraphMessagesTestModule["searchMessagesMSTeams"];

beforeAll(async () => {
  ({ searchMessagesMSTeams } = await loadGraphMessagesTestModule());
});

describe("searchMessagesMSTeams", () => {
  it("returns messages whose body contains the query and drops non-matches", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "Meeting notes from Monday" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
        {
          id: "msg-2",
          body: { content: "Lunch tomorrow?" },
          from: { user: { id: "u2", displayName: "Bob" } },
          createdDateTime: "2026-03-25T10:05:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "meeting notes",
    });

    expect(result.messages).toEqual([
      {
        id: "msg-1",
        text: "Meeting notes from Monday",
        from: { user: { id: "u1", displayName: "Alice" } },
        createdAt: "2026-03-25T10:00:00Z",
      },
    ]);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(`/chats/${encodeURIComponent(CHAT_ID)}/messages?`);
  });

  it("matches case-insensitively", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "Quarterly Review On Friday" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "QUARTERLY review",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
  });

  it("searches channel messages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-2",
          body: { content: "Sprint review" },
          from: { user: { id: "u2", displayName: "Bob" } },
          createdDateTime: "2026-03-25T11:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      query: "sprint",
    });

    expect(result.messages).toHaveLength(1);
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("/teams/team-id-1/channels/channel-id-1/messages?");
  });

  it("does not use Graph $search (unsupported under Application permissions)", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "anything",
    });

    const call = mockState.fetchGraphJson.mock.calls[0][0];
    const calledPath = call.path as string;
    expect(calledPath).not.toContain("$search");
    expect(decodeURIComponent(calledPath)).not.toContain("$search");
    expect(call.headers).toBeUndefined();
  });

  it("requests Graph's max page size ($top=50) regardless of limit", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      limit: 5,
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    // Graph caps $top at 50 on chat/channel message endpoints; wider windows
    // must come from @odata.nextLink pagination, not a larger $top.
    expect(calledPath).toContain("$top=50");
    expect(calledPath).not.toContain("$top=200");
  });

  it("pages through @odata.nextLink until the list window is reached", async () => {
    const page1Value = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      body: { content: `no match ${i}` },
    }));
    const page2Value = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${50 + i}`,
      body: { content: i === 5 ? "match needle here" : `no match ${50 + i}` },
    }));
    mockState.fetchGraphJson.mockResolvedValue({
      value: page1Value,
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/next-page",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({ value: page2Value });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "needle",
      limit: 50,
    });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(1);
    expect(mockState.fetchGraphAbsoluteUrl.mock.calls[0][0].url).toBe(
      "https://graph.microsoft.com/v1.0/chats/next-page",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-55");
  });

  it("stops paginating once the list window is filled", async () => {
    // With limit=5, list window = 50; page 1 already returns 50 items, so
    // we should NOT follow @odata.nextLink.
    mockState.fetchGraphJson.mockResolvedValue({
      value: Array.from({ length: 50 }, (_, i) => ({
        id: `msg-${i}`,
        body: { content: `ping ${i}` },
      })),
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/next-page",
    });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "ping",
      limit: 5,
    });

    expect(mockState.fetchGraphAbsoluteUrl).not.toHaveBeenCalled();
  });

  it("caps returned matches at the effective limit after local filtering", async () => {
    const value = Array.from({ length: 12 }, (_, index) => ({
      id: `msg-${index}`,
      body: { content: `ping ${index}` },
      from: { user: { id: `u${index}`, displayName: `User ${index}` } },
      createdDateTime: "2026-03-25T10:00:00Z",
    }));
    mockState.fetchGraphJson.mockResolvedValue({ value });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "ping",
      limit: 3,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);
  });

  it("applies from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "budget",
      from: "Alice",
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain("$filter=");
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("from/user/displayName eq 'Alice'");
  });

  it("escapes single quotes in from filter", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "test",
      from: "O'Brien",
    });

    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    const decoded = decodeURIComponent(calledPath);
    expect(decoded).toContain("O''Brien");
  });

  it("strips double quotes from the query before local matching", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "say hello world — greetings" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: 'say "hello" world',
    });

    expect(result.messages).toHaveLength(1);
  });

  it("matches against rendered text, not raw HTML, when contentType is html", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
        {
          id: "msg-2",
          body: { content: "<p>no match here</p>", contentType: "html" },
          from: { user: { id: "u2", displayName: "Bob" } },
          createdDateTime: "2026-03-25T10:05:00Z",
        },
      ],
    });

    // Query "<b>" should NOT match the <b> tag in msg-1's markup.
    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "<b>",
    });

    expect(result.messages).toEqual([]);
  });

  it("matches rendered text inside HTML bodies", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "<p>Hello <b>world</b></p>", contentType: "html" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "hello world",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
  });

  it("leaves bodies with contentType 'text' untouched (no HTML-strip)", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "plain <b>text</b> literal", contentType: "text" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    // With contentType "text", the angle brackets are literal characters.
    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "<b>",
    });

    expect(result.messages).toHaveLength(1);
  });

  it("preserves @mention display names in HTML content for matching", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: {
            content: '<p>hey <at id="0">Alice</at> ping</p>',
            contentType: "html",
          },
          from: { user: { id: "u1", displayName: "Bob" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "@alice",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
  });

  it("returns empty array when no messages match", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "unrelated chatter" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "nonexistent",
    });

    expect(result.messages).toEqual([]);
  });

  it("returns every fetched message when the query is empty (after quote strip)", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "anything" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: '""',
    });

    expect(result.messages).toHaveLength(1);
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      query: "hello",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    const calledPath = mockState.fetchGraphJson.mock.calls[0][0].path as string;
    expect(calledPath).toContain(
      `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages?`,
    );
  });
});
