import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  getMessageMSTeams,
  listPinsMSTeams,
  pinMessageMSTeams,
  unpinMessageMSTeams,
} from "./graph-messages.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  postGraphJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  resolveGraphToken: mockState.resolveGraphToken,
  fetchGraphJson: mockState.fetchGraphJson,
  postGraphJson: mockState.postGraphJson,
  deleteGraphRequest: mockState.deleteGraphRequest,
}));

const TOKEN = "test-graph-token";
const CHAT_ID = "19:abc@thread.tacv2";
const CHANNEL_TO = "team-id-1/channel-id-1";

describe("getMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("reads a message from a chat conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello world", contentType: "text" },
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({
      id: "msg-1",
      text: "Hello world",
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdAt: "2026-03-23T10:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
    });
  });

  it("reads a message from a channel conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-2",
      body: { content: "Channel message" },
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdDateTime: "2026-03-23T11:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result).toEqual({
      id: "msg-2",
      text: "Channel message",
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdAt: "2026-03-23T11:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
    });
  });
});

describe("pinMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("pins a message in a chat", async () => {
    mockState.postGraphJson.mockResolvedValue({ id: "pinned-1" });

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages`,
      body: { message: { id: "msg-1" } },
    });
  });

  it("pins a message in a channel", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/pinnedMessages",
      body: { message: { id: "msg-2" } },
    });
  });
});

describe("unpinMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "pinned-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/pinned-1`,
    });
  });

  it("unpins a message from a channel", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "pinned-2",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/pinnedMessages/pinned-2",
    });
  });
});

describe("listPinsMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("lists pinned messages in a chat", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "pinned-1",
          message: { id: "msg-1", body: { content: "Pinned msg" } },
        },
        {
          id: "pinned-2",
          message: { id: "msg-2", body: { content: "Another pin" } },
        },
      ],
    });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([
      { pinnedMessageId: "pinned-1", messageId: "msg-1", text: "Pinned msg" },
      { pinnedMessageId: "pinned-2", messageId: "msg-2", text: "Another pin" },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages?$expand=message`,
    });
  });

  it("returns empty array when no pins exist", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([]);
  });
});
