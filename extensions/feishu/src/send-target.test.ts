// Feishu tests cover send target plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let resolveFeishuSendTarget: typeof import("./send-target.js").resolveFeishuSendTarget;

describe("resolveFeishuSendTarget", () => {
  const cfg = {} as ClawdbotConfig;
  const client = { id: "client" };

  beforeAll(async () => {
    ({ resolveFeishuSendTarget } = await import("./send-target.js"));
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    resolveFeishuAccountMock.mockReset().mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
    });
    createFeishuClientMock.mockReset().mockReturnValue(client);
  });

  it.each([
    ["feishu:group:group_room_alpha", "group_room_alpha", "chat_id"],
    ["lark:dm:ou_123", "ou_123", "open_id"],
    ["  feishu:dm:user_123  ", "user_123", "user_id"],
  ])("resolves %s to %s with receive-id type %s", (to, receiveId, receiveIdType) => {
    const result = resolveFeishuSendTarget({ cfg, to });
    expect(result.receiveId).toBe(receiveId);
    expect(result.receiveIdType).toBe(receiveIdType);
    expect(result.client).toBe(client);
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
