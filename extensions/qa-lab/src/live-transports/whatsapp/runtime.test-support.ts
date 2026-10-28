import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";

export const phones = { driverPhoneE164: "+15550000001", sutPhoneE164: "+15550000002" };
export const groupJid = "120363000000000000@g.us";
export const runtimeEnv = {
  ...phones,
  groupJid,
  driverAuthArchiveBase64: "unused",
  sutAuthArchiveBase64: "unused",
};
const exec = promisify(execFile);

export async function createArchive(root: string, entries: Record<string, string>) {
  const source = path.join(root, "src");
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const archive = path.join(root, "archive.tgz");
  await exec("tar", ["-czf", archive, "-C", source, "."]);
  return fs.readFile(archive, "base64");
}

export function observedMessage<const T extends Partial<WhatsAppQaDriverObservedMessage>>(
  messageId: string,
  overrides: T,
): WhatsAppQaDriverObservedMessage & T {
  return {
    fromPhoneE164: phones.sutPhoneE164,
    kind: "text",
    messageId,
    observedAt: "2026-06-21T12:00:01.000Z",
    text: "ok",
    ...overrides,
  } as WhatsAppQaDriverObservedMessage & T;
}

export function createDriver(
  overrides: Partial<WhatsAppQaDriverSession> = {},
): WhatsAppQaDriverSession {
  const send = async () => ({});
  return {
    close: async () => {},
    getObservedMessages: () => [],
    sendContact: send,
    sendLocation: send,
    sendMedia: send,
    sendPoll: send,
    sendReaction: send,
    sendSticker: send,
    sendText: send,
    waitForMessage: async () => ({
      kind: "text",
      text: "ok",
      observedAt: new Date().toISOString(),
    }),
    ...overrides,
  };
}
