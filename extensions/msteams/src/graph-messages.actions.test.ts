import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  pinMessageMSTeams,
  reactMessageMSTeams,
  unpinMessageMSTeams,
  unreactMessageMSTeams,
} from "./graph-messages.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  postGraphJson: vi.fn(),
  postGraphBetaJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
    postGraphJson: mockState.postGraphJson,
    postGraphBetaJson: mockState.postGraphBetaJson,
    deleteGraphRequest: mockState.deleteGraphRequest,
  };
});

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({
    findPreferredDmByUserId: mockState.findPreferredDmByUserId,
  }),
}));

const TOKEN = "test-graph-token";
const CHAT_ID = "19:abc@thread.tacv2";
const CHANNEL_TO = "team-id-1/channel-id-1";

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
      pinnedMessageId: "pinned-1",
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
      pinnedMessageId: "pinned-2",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/pinnedMessages/pinned-2",
    });
  });
});

describe("reactMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("sets a like reaction on a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "like",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "like" },
    });
  });

  it("sets a reaction on a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
      reactionType: "heart",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/setReaction",
      body: { reactionType: "heart" },
    });
  });

  it("normalizes reaction type to lowercase", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "LAUGH",
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      body: { reactionType: "laugh" },
    });
  });

  it("rejects invalid reaction type", async () => {
    await expect(
      reactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "thumbsup",
      }),
    ).rejects.toThrow('Invalid reaction type "thumbsup"');
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-user-1",
      messageId: "msg-1",
      reactionType: "like",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages/msg-1/setReaction`,
      body: { reactionType: "like" },
    });
  });
});

describe("unreactMessageMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

  it("removes a reaction from a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
      reactionType: "sad",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/unsetReaction`,
      body: { reactionType: "sad" },
    });
  });

  it("removes a reaction from a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
      reactionType: "angry",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/unsetReaction",
      body: { reactionType: "angry" },
    });
  });

  it("rejects invalid reaction type", async () => {
    await expect(
      unreactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "clap",
      }),
    ).rejects.toThrow('Invalid reaction type "clap"');
  });
});
