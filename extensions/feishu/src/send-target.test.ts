import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuSendTarget } from "./send-target.js";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("resolveFeishuSendTarget", () => {
  const cfg = {} as ClawdbotConfig;
  const client = { id: "client" };

  beforeEach(() => {
    resolveFeishuAccountMock.mockReset().mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
    });
    createFeishuClientMock.mockReset().mockReturnValue(client);
  });

  it("keeps explicit group targets as chat_id even when ID shape is ambiguous", () => {
    const result = resolveFeishuSendTarget({
      cfg,
      to: "feishu:group:group_room_alpha",
    });

    expect(result.receiveId).toBe("group_room_alpha");
    expect(result.receiveIdType).toBe("chat_id");
    expect(result.client).toBe(client);
  });

  it("maps dm-prefixed open IDs to open_id", () => {
    const result = resolveFeishuSendTarget({
      cfg,
      to: "lark:dm:ou_123",
    });

    expect(result.receiveId).toBe("ou_123");
    expect(result.receiveIdType).toBe("open_id");
  });

  it("maps dm-prefixed non-open IDs to user_id", () => {
    const result = resolveFeishuSendTarget({
      cfg,
      to: "  feishu:dm:user_123  ",
    });

    expect(result.receiveId).toBe("user_123");
    expect(result.receiveIdType).toBe("user_id");
  });

  it("blocks explicit group targets when disableGroupReplies is enabled", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        disableGroupReplies: true,
      },
    });

    expect(() =>
      resolveFeishuSendTarget({
        cfg,
        to: "feishu:group:oc_123",
      }),
    ).toThrow('Feishu group replies are disabled by config for account "default"');
  });

  it("blocks group targets with whitespace after provider prefix", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        disableGroupReplies: true,
      },
    });

    expect(() =>
      resolveFeishuSendTarget({
        cfg,
        to: "feishu: group:oc_123",
      }),
    ).toThrow('Feishu group replies are disabled by config for account "default"');
  });

  it("still allows dm targets when disableGroupReplies is enabled", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        disableGroupReplies: true,
      },
    });

    const result = resolveFeishuSendTarget({
      cfg,
      to: "feishu:user:ou_123",
    });

    expect(result.receiveId).toBe("ou_123");
    expect(result.receiveIdType).toBe("open_id");
  });

  it("throws when target account is not configured", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: false,
    });

    expect(() =>
      resolveFeishuSendTarget({
        cfg,
        to: "feishu:group:oc_123",
      }),
    ).toThrow('Feishu account "default" not configured');
  });
});
