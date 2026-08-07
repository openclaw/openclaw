// Qqbot tests cover the bot-upgrade command reply through the real dispatch seam.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../../gateway/message-queue.js";
import type { GatewayAccount } from "../../gateway/types.js";
import { sendText } from "../../messaging/sender.js";
import { trySlashCommand } from "../slash-command-handler.js";
import { installCommandRuntime } from "../slash-command-test-support.js";

vi.mock("../../messaging/outbound.js", () => ({
  sendDocument: vi.fn(async () => undefined),
}));

vi.mock("../../messaging/sender.js", () => ({
  accountToCreds: vi.fn(() => ({ appId: "app", clientSecret: "" })),
  buildDeliveryTarget: vi.fn(() => ({ targetType: "c2c", targetId: "TRUSTED_OPENID" })),
  sendText: vi.fn(async () => undefined),
}));

const BUNDLED_GUIDE_HOST = "q.qq.com/qqbot/openclaw/upgrade.html";

const queueSnapshot = {
  totalPending: 0,
  activeUsers: 0,
  maxConcurrentUsers: 1,
  senderPending: 0,
};

function createUpgradeMessage(): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: "/bot-upgrade",
    messageId: "msg-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  } as QueuedMessage;
}

function createAccount(accountConfig: Record<string, unknown>): GatewayAccount {
  return {
    accountId: "default",
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: { allowFrom: ["*"], ...accountConfig },
  } as GatewayAccount;
}

async function runUpgradeCommand(accountConfig: Record<string, unknown>) {
  const config = {
    commands: { allowFrom: { qqbot: ["TRUSTED_OPENID"] } },
    channels: { qqbot: { allowFrom: ["*"], ...accountConfig } },
  } as OpenClawConfig;
  installCommandRuntime(config, []);

  await trySlashCommand(createUpgradeMessage(), {
    account: createAccount(accountConfig),
    cfg: config,
    getMessagePeerId: () => "c2c:TRUSTED_OPENID",
    getQueueSnapshot: () => queueSnapshot,
  });

  return vi.mocked(sendText).mock.calls.at(0)?.[1] ?? "";
}

describe("bot-upgrade command reply", () => {
  beforeEach(() => {
    vi.mocked(sendText).mockClear();
  });

  it("sends the operator-configured upgrade url to the chat", async () => {
    const reply = await runUpgradeCommand({ upgradeUrl: "https://ops.example.com/qqbot-upgrade" });

    expect(reply).toContain("https://ops.example.com/qqbot-upgrade");
    expect(reply).not.toContain(BUNDLED_GUIDE_HOST);
  });

  it("sends the bundled guide when the key is unset or blank", async () => {
    expect(await runUpgradeCommand({})).toContain(BUNDLED_GUIDE_HOST);

    vi.mocked(sendText).mockClear();
    expect(await runUpgradeCommand({ upgradeUrl: "   " })).toContain(BUNDLED_GUIDE_HOST);
  });
});
