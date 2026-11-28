import { describe, expect, it, vi, beforeEach } from "vitest";

const getChatInfoMock = vi.fn();
const getChatMembersMock = vi.fn();

vi.mock("./chat.js", () => ({
  getChatInfo: (...args: unknown[]) => getChatInfoMock(...args),
  getChatMembers: (...args: unknown[]) => getChatMembersMock(...args),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: () => ({}),
}));

const { resolveFeishuOutboundSessionRoute } = await import("./session-route.js");

describe("resolveFeishuOutboundSessionRoute", () => {
  beforeEach(() => {
    getChatInfoMock.mockReset();
    getChatMembersMock.mockReset();
  });

  it("uses Feishu receive-id semantics for canonical recipient sessions", async () => {
    const group = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "ou_user",
    });
    const direct = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "ou_user",
    });
    const legacyUserId = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "user:legacy_user_id",
    });

    expect(direct).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "direct", id: "ou_user" },
      to: "ou_user",
    });
    expect(group).toMatchObject({ peer: { kind: "direct" }, chatType: "direct" });
    expect(legacyUserId?.recipientSessionExact).toBe(false);
  });

  it("routes a p2p chat id to the sender-scoped direct peer while keeping the chat address", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_dm", chat_mode: "p2p" });
    // The member list of a p2p chat excludes bot members, so the single
    // returned member is the human counterpart.
    getChatMembersMock.mockResolvedValue({ members: [{ member_id: "ou_sender" }] });

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_dm",
    });

    expect(route).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "direct", id: "ou_sender" },
      chatType: "direct",
      from: "feishu:ou_sender",
      to: "chat:oc_dm",
    });
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(getChatMembersMock).toHaveBeenCalledWith(
      expect.anything(),
      "oc_dm",
      2,
      undefined,
      "open_id",
    );
  });

  it("keeps genuine groups group-scoped", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_group", chat_mode: "group" });

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_group",
    });

    expect(route).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "group", id: "oc_group" },
      chatType: "group",
      to: "chat:oc_group",
    });
    expect(getChatMembersMock).not.toHaveBeenCalled();
  });

  it("falls back to group routing when p2p chats cannot name the counterpart", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_dm", chat_mode: "p2p" });
    getChatMembersMock.mockResolvedValue({ members: [] });

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_dm",
    });

    expect(route).toMatchObject({
      peer: { kind: "group", id: "oc_dm" },
      chatType: "group",
    });
  });

  it("keeps group routing when the p2p member page is ambiguous", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_dm", chat_mode: "p2p" });
    getChatMembersMock.mockResolvedValue({
      members: [{ member_id: "ou_a" }, { member_id: "ou_b" }],
    });

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_dm",
    });

    expect(route).toMatchObject({
      peer: { kind: "group", id: "oc_dm" },
      chatType: "group",
    });
  });

  it("falls back to group routing when the p2p member lookup fails", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_dm", chat_mode: "p2p" });
    getChatMembersMock.mockRejectedValue(new Error("feishu unavailable"));

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_dm",
    });

    expect(route).toMatchObject({
      peer: { kind: "group", id: "oc_dm" },
      chatType: "group",
    });
  });

  it("revalidates transport authority before route-discovery reads", async () => {
    await expect(
      resolveFeishuOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        target: "oc_dm",
        assertDirectAdapterHandoff: () => {
          throw new Error("sender retired");
        },
      }),
    ).rejects.toThrow("sender retired");
    expect(getChatInfoMock).not.toHaveBeenCalled();
    expect(getChatMembersMock).not.toHaveBeenCalled();
  });

  it("falls back to group routing when chat metadata cannot be resolved", async () => {
    getChatInfoMock.mockRejectedValue(new Error("feishu unavailable"));

    const route = await resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_unknown",
    });

    expect(route).toMatchObject({
      peer: { kind: "group", id: "oc_unknown" },
      chatType: "group",
    });
  });

  it("does not claim an exact group route when inbound sessions include sender or topic", async () => {
    getChatInfoMock.mockResolvedValue({ chat_id: "oc_group", chat_mode: "group" });
    const accountScoped = await resolveFeishuOutboundSessionRoute({
      cfg: {
        channels: {
          feishu: {
            groupSessionScope: "group_sender",
          },
        },
      },
      agentId: "main",
      target: "oc_group",
    });
    const groupScoped = await resolveFeishuOutboundSessionRoute({
      cfg: {
        channels: {
          feishu: {
            groupSessionScope: "group",
            groups: {
              oc_group: { groupSessionScope: "group_topic" },
            },
          },
        },
      },
      agentId: "main",
      target: "oc_group",
    });

    expect(accountScoped?.recipientSessionExact).toBe(false);
    expect(groupScoped?.recipientSessionExact).toBe(false);
  });
});
