// Qqbot tests cover outbound media send metadata passed to the QQ sender.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOutboundFileName } from "./outbound-file-name.js";
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

const UUID = "e46cdea3-a285-48f6-958d-ad31352855d6";

describe("sendDocument", () => {
  it("passes the recipient-facing filename to QQ file sends", async () => {
    const tmpDir = makeTrackedDir("qqbot-send-doc-");
    const stagedPath = path.join(tmpDir, `report---${UUID}.txt`);
    fs.writeFileSync(stagedPath, "hello");
    sendMediaMock.mockResolvedValue({ id: "qq-msg-1", timestamp: "123" });

    const expectedFileName = await resolveOutboundFileName(stagedPath);

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
        fileName: expectedFileName,
        source: { localPath: stagedPath },
        localPathForMeta: stagedPath,
      }),
    );
  });
});

describe("resolveOutboundFileName integration", () => {
  it("strips UUID suffix for paths inside the media store", async () => {
    const { getMediaDir } = await import("openclaw/plugin-sdk/media-runtime");
    const mediaDir = getMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });

    const stagedPath = path.join(mediaDir, `report---${UUID}.txt`);
    expect(await resolveOutboundFileName(stagedPath)).toBe("report.txt");
  });

  it("preserves UUID-shaped filenames outside the media store", async () => {
    const outsidePath = path.join("/tmp", `report---${UUID}.txt`);
    expect(await resolveOutboundFileName(outsidePath)).toBe(`report---${UUID}.txt`);
  });
});
