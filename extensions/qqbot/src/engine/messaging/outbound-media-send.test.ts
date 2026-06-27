// Qqbot tests cover outbound media send metadata passed to the QQ sender.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendDocument } from "./outbound-media-send.js";

const sendMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./sender.js", () => ({
  UploadDailyLimitExceededError: class UploadDailyLimitExceededError extends Error {},
  accountToCreds: (account: { appId: string; clientSecret: string }) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  sendMedia: sendMediaMock,
  sendText: vi.fn(),
}));

const cleanupPaths: string[] = [];

afterEach(() => {
  sendMediaMock.mockReset();
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
});

function makeTrackedDir(prefix: string): string {
  const dir = path.join(resolvePreferredOpenClawTmpDir(), `${prefix}${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  cleanupPaths.push(dir);
  return dir;
}

describe("sendDocument", () => {
  it("passes the recipient-facing media-store filename to QQ file sends", async () => {
    const mediaDir = makeTrackedDir("qqbot-send-doc-");
    const stagedPath = path.join(mediaDir, "report---e46cdea3-a285-48f6-958d-ad31352855d6.txt");
    fs.writeFileSync(stagedPath, "hello");
    sendMediaMock.mockResolvedValue({ id: "qq-msg-1", timestamp: "123" });

    const result = await sendDocument(
      {
        targetType: "group",
        targetId: "group-openid",
        account: {
          accountId: "default",
          appId: "app-id",
          clientSecret: "client-secret",
          enabled: true,
          config: {},
        },
      },
      stagedPath,
    );

    expect(result).toEqual({ channel: "qqbot", messageId: "qq-msg-1", timestamp: "123" });
    expect(sendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        fileName: "report.txt",
        source: { localPath: stagedPath },
        localPathForMeta: stagedPath,
      }),
    );
  });
});
