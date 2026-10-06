// Msteams tests cover graph group management plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  addParticipantMSTeams,
  removeParticipantMSTeams,
  renameGroupMSTeams,
} from "./graph-group-management.js";
import { createGraphPageGuard } from "./graph-pagination.test-support.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  mutateGraphJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return { ...actual, fetchWithSsrFGuard: mockState.fetchWithSsrFGuard };
});

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
    mutateGraphJson: mockState.mutateGraphJson,
    deleteGraphRequest: mockState.deleteGraphRequest,
  };
});

vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({
    findPreferredDmByUserId: mockState.findPreferredDmByUserId,
  }),
}));

const TOKEN = "test-graph-token";
const CHAT_ID = "19:abc@thread.tacv2";
const CHANNEL_TO = "team-id-1/channel-id-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  mockState.fetchWithSsrFGuard.mockImplementation(createGraphPageGuard(mockState.fetchGraphJson));
});

describe("addParticipantMSTeams", () => {
  it.each([
    { name: "default chat member", to: CHAT_ID, role: undefined, roles: ["owner"] },
    { name: "normalized chat owner", to: CHAT_ID, role: " OWNER ", roles: ["owner"] },
    { name: "default channel member", to: CHANNEL_TO, role: undefined, roles: [] },
    { name: "channel owner", to: CHANNEL_TO, role: "owner", roles: ["owner"] },
  ])("adds $name with Graph roles and escaped user binding", async ({ to, role, roles }) => {
    mockState.mutateGraphJson.mockResolvedValue({});
    const userId = "o'hara@example.com";

    await expect(addParticipantMSTeams({ cfg: {}, to, userId, role })).resolves.toEqual({
      added: { userId, chatId: to },
    });
    expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path:
        to === CHAT_ID
          ? `/chats/${encodeURIComponent(CHAT_ID)}/members`
          : "/teams/team-id-1/channels/channel-id-1/members",
      method: "POST",
      body: {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles,
        "user@odata.bind": "https://graph.microsoft.com/v1.0/users('o''hara@example.com')",
      },
    });
  });

  it("rejects unknown roles", async () => {
    await expect(
      addParticipantMSTeams({
        cfg: {},
        to: CHAT_ID,
        userId: "user-aad-id-2",
        role: "admin",
      }),
    ).rejects.toThrow('role must be "member" or "owner"');
    expect(mockState.mutateGraphJson).not.toHaveBeenCalled();
  });
});

describe("removeParticipantMSTeams", () => {
  it("lists members, finds match, deletes by membershipId", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "membership-1", userId: "user-aad-id-1" },
        { id: "membership-2", userId: "user-aad-id-2" },
      ],
    });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: "user-aad-id-2",
    });

    expect(result).toEqual({ removed: { userId: "user-aad-id-2", chatId: CHAT_ID } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members/membership-2`,
    });
  });

  it("throws when user not found in member list", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "membership-1", userId: "user-aad-id-1" },
        { id: "membership-3", userId: "user-aad-id-3" },
      ],
    });

    await expect(
      removeParticipantMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        userId: "user-not-in-list",
      }),
    ).rejects.toThrow("User user-not-in-list is not a member of this conversation");
  });

  it("removes member from a channel", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "membership-5", userId: "user-aad-id-5" }],
    });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      userId: "user-aad-id-5",
    });

    expect(result).toEqual({ removed: { userId: "user-aad-id-5", chatId: CHANNEL_TO } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/members",
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/members/membership-5",
    });
  });

  it("follows member pagination before concluding the user is missing", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({
        value: [{ id: "membership-1", userId: "user-aad-id-1" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/members?$skip=2",
      })
      .mockResolvedValueOnce({
        value: [{ id: "membership-9", email: " User-AAD-ID-9 " }],
      });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipantMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      userId: " USER-AAD-ID-9 ",
    });

    expect(result).toEqual({ removed: { userId: " USER-AAD-ID-9 ", chatId: CHAT_ID } });
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(1, {
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members`,
    });
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(2, {
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members?$skip=2`,
    });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members/membership-9`,
    });
  });

  it("accepts a match on the final allowed page even when another page is advertised", async () => {
    let page = 0;
    mockState.fetchGraphJson.mockImplementation(async () => {
      page += 1;
      return {
        value: page === 100 ? [{ id: "membership-final", userId: "user-final" }] : [],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/chat/members?$skip=next",
      };
    });
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    await expect(
      removeParticipantMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        userId: "user-final",
      }),
    ).resolves.toEqual({ removed: { userId: "user-final", chatId: CHAT_ID } });
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(100);
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/members/membership-final`,
    });
  });

  it("preserves the exact pagination-limit failure after 100 unmatched pages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/chat/members?$skip=next",
    });

    await expect(
      removeParticipantMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHAT_ID,
        userId: "missing",
      }),
    ).rejects.toThrow("MS Teams conversation member pagination limit exceeded");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(100);
    expect(mockState.deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("renameGroupMSTeams", () => {
  it.each([
    { to: CHAT_ID, path: `/chats/${encodeURIComponent(CHAT_ID)}`, body: { topic: "New Name" } },
    {
      to: CHANNEL_TO,
      path: "/teams/team-id-1/channels/channel-id-1",
      body: { displayName: "New Name" },
    },
  ])("renames $to with the provider's name field", async ({ to, path, body }) => {
    mockState.mutateGraphJson.mockResolvedValue(undefined);
    await expect(renameGroupMSTeams({ cfg: {}, to, name: "New Name" })).resolves.toEqual({
      renamed: { chatId: to, newName: "New Name" },
    });
    expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path,
      method: "PATCH",
      body,
    });
  });
});
