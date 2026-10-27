import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addParticipantMSTeams as addParticipant,
  removeParticipantMSTeams as removeParticipant,
  renameGroupMSTeams as renameGroup,
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
const CHAT_PATH = `/chats/${encodeURIComponent(CHAT_ID)}`;
const CHANNEL_PATH = "/teams/team-id-1/channels/channel-id-1";
const target = { cfg: {}, to: CHAT_ID };
const missingMember = () => removeParticipant({ ...target, userId: "missing" });
const graphRequest = (path: string, fields: object = {}) => ({ token: TOKEN, path, ...fields });
const { fetchGraphJson, mutateGraphJson, deleteGraphRequest } = mockState;

beforeEach(() => {
  vi.clearAllMocks();
  mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  mockState.fetchWithSsrFGuard.mockImplementation(createGraphPageGuard(mockState.fetchGraphJson));
});

describe("addParticipantMSTeams", () => {
  it.each([
    { name: "normalized chat owner", to: CHAT_ID, role: " OWNER ", roles: ["owner"] },
    { name: "default channel member", to: CHANNEL_TO, role: undefined, roles: [] },
    { name: "channel owner", to: CHANNEL_TO, role: "owner", roles: ["owner"] },
  ])("adds $name with Graph roles and escaped user binding", async ({ to, role, roles }) => {
    mutateGraphJson.mockResolvedValue({});
    const userId = "o'hara@example.com";

    await expect(addParticipant({ cfg: {}, to, userId, role })).resolves.toEqual({
      added: { userId, chatId: to },
    });
    expect(mutateGraphJson).toHaveBeenCalledWith(
      graphRequest(`${to === CHAT_ID ? CHAT_PATH : CHANNEL_PATH}/members`, {
        method: "POST",
        body: {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles,
          "user@odata.bind": "https://graph.microsoft.com/v1.0/users('o''hara@example.com')",
        },
      }),
    );
  });

  it("rejects unknown roles", async () => {
    await expect(
      addParticipant({ ...target, userId: "user-aad-id-2", role: "admin" }),
    ).rejects.toThrow('role must be "member" or "owner"');
    expect(mutateGraphJson).not.toHaveBeenCalled();
  });
});

describe("removeParticipantMSTeams", () => {
  it("throws when user not found in member list", async () => {
    fetchGraphJson.mockResolvedValue({
      value: [
        { id: "membership-1", userId: "user-aad-id-1" },
        { id: "membership-3", userId: "user-aad-id-3" },
      ],
    });

    await expect(missingMember()).rejects.toThrow(
      "User missing is not a member of this conversation",
    );
  });

  it("follows member pagination before concluding the user is missing", async () => {
    fetchGraphJson
      .mockResolvedValueOnce({
        value: [{ id: "membership-1", userId: "user-aad-id-1" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/members?$skip=2",
      })
      .mockResolvedValueOnce({
        value: [{ id: "membership-9", email: " User-AAD-ID-9 " }],
      });
    deleteGraphRequest.mockResolvedValue(undefined);

    const result = await removeParticipant({ ...target, userId: " USER-AAD-ID-9 " });

    expect(result).toEqual({ removed: { userId: " USER-AAD-ID-9 ", chatId: CHAT_ID } });
    expect(fetchGraphJson.mock.calls).toEqual([
      [graphRequest(`${CHAT_PATH}/members`)],
      [graphRequest(`${CHAT_PATH}/members?$skip=2`)],
    ]);
    expect(deleteGraphRequest).toHaveBeenCalledWith(
      graphRequest(`${CHAT_PATH}/members/membership-9`),
    );
  });

  it("preserves the exact pagination-limit failure after 100 unmatched pages", async () => {
    fetchGraphJson.mockResolvedValue({
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/chat/members?$skip=next",
    });

    await expect(missingMember()).rejects.toThrow(
      "MS Teams conversation member pagination limit exceeded",
    );
    expect(fetchGraphJson).toHaveBeenCalledTimes(100);
    expect(deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("renameGroupMSTeams", () => {
  it.each([
    { to: CHAT_ID, path: CHAT_PATH, body: { topic: "New Name" } },
    { to: CHANNEL_TO, path: CHANNEL_PATH, body: { displayName: "New Name" } },
  ])("renames $to with the provider's name field", async ({ to, path, body }) => {
    mutateGraphJson.mockResolvedValue(undefined);
    await expect(renameGroup({ cfg: {}, to, name: "New Name" })).resolves.toEqual({
      renamed: { chatId: to, newName: "New Name" },
    });
    expect(mutateGraphJson).toHaveBeenCalledWith(graphRequest(path, { method: "PATCH", body }));
  });
});
