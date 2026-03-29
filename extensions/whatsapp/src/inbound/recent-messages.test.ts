import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRecentWhatsAppMessage,
  rememberRecentWhatsAppMessage,
  resetRecentWhatsAppMessages,
} from "./recent-messages.js";

describe("recent WhatsApp messages", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetRecentWhatsAppMessages();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches device-scoped direct JIDs against normalized outbound JIDs", () => {
    rememberRecentWhatsAppMessage({
      accountId: "main",
      remoteJid: "15551234567:12@s.whatsapp.net",
      message: {
        key: {
          id: "msg-1",
          remoteJid: "15551234567:12@s.whatsapp.net",
        },
        message: { conversation: "hello" },
      },
    });

    expect(
      getRecentWhatsAppMessage({
        accountId: "main",
        remoteJid: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
      }),
    ).toMatchObject({
      key: expect.objectContaining({ id: "msg-1" }),
      message: { conversation: "hello" },
    });
  });

  it("matches LID-backed chats against normalized outbound JIDs when authDir is available", () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-"));
    tempDirs.push(authDir);
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-123_reverse.json"),
      JSON.stringify("+15557654321"),
    );

    rememberRecentWhatsAppMessage({
      accountId: "main",
      remoteJid: "123@lid",
      authDir,
      message: {
        key: {
          id: "msg-2",
          remoteJid: "123@lid",
        },
        message: { conversation: "hello from lid" },
      },
    });

    expect(
      getRecentWhatsAppMessage({
        accountId: "main",
        remoteJid: "15557654321@s.whatsapp.net",
        messageId: "msg-2",
        authDir,
      }),
    ).toMatchObject({
      key: expect.objectContaining({ id: "msg-2" }),
      message: { conversation: "hello from lid" },
    });
  });
});
