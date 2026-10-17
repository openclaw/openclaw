import * as childProcess from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GrokBotAuthOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
};

const SIGN_IN =
  "Sign in to Grok Bot on this Mac, then retry, or provide GROK_BOT_ACCESS_TOKEN in the environment.";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: The guard excludes null, arrays, and primitives; property values remain unknown.
  return value as Record<string, unknown>;
}

async function readActiveToken(homeDir: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      path.join(homeDir, "Library/Application Support/Grok Bot/sand-secrets.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error("Invalid storage");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > stat.size) {
      throw new Error("Storage changed");
    }
    const disk = record(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    if (disk?.version !== 1 || typeof disk["cursor-accounts"] !== "string") {
      throw new Error("Unsupported storage");
    }
    const saved = record(JSON.parse(disk["cursor-accounts"]));
    const accounts = record(saved?.accounts);
    const active = typeof saved?.active === "string" ? record(accounts?.[saved.active]) : undefined;
    const encoded = active?.["cursor-access-token"];
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      throw new Error("No active token");
    }
    const encrypted = Buffer.from(encoded, "base64");
    if (
      encrypted.subarray(0, 3).toString() !== "v10" ||
      encrypted.length <= 3 ||
      (encrypted.length - 3) % 16 !== 0
    ) {
      throw new Error("Unsupported cipher");
    }
    return encrypted;
  } catch {
    // Never expose parse input or credentials through an error cause.
    throw new Error(`Could not read the active Grok Bot sign-in. ${SIGN_IN}`);
  } finally {
    await handle?.close();
  }
}

function readSafeStoragePassword(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Grok Bot Safe Storage", "-w"],
      { encoding: "buffer", timeout: 30_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              "Grok Bot's macOS Keychain could not be read. Unlock the login Keychain and approve access to Grok Bot Safe Storage on this Mac, then retry. If using SSH, run the import in a logged-in desktop terminal so macOS can show its approval.",
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Explicit import operations only: never call during plugin load or passive discovery. */
export async function resolveGrokBotAccessToken(options: GrokBotAuthOptions = {}): Promise<string> {
  const explicit = (options.env ?? process.env).GROK_BOT_ACCESS_TOKEN?.trim();
  if (explicit) {
    if (/[\r\n]/u.test(explicit)) {
      throw new Error("GROK_BOT_ACCESS_TOKEN must contain one token without line breaks.");
    }
    return explicit;
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error(
      "Provide GROK_BOT_ACCESS_TOKEN in the environment to import authenticated Grok Bots on this platform.",
    );
  }
  const encrypted = await readActiveToken(options.homeDir ?? os.homedir());
  const passwordOutput = await readSafeStoragePassword();
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    const password = passwordOutput.at(-1) === 10 ? passwordOutput.subarray(0, -1) : passwordOutput;
    // Chromium OSCrypt macOS v10, also used by Electron safeStorage:
    // chromium/134.0.6998.35/components/os_crypt/sync/os_crypt_mac.mm
    key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const token = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!token || token.trim() !== token || /[\r\n]/u.test(token)) {
      throw new Error("Invalid token");
    }
    return token;
  } catch {
    throw new Error(`Could not decrypt the active Grok Bot sign-in. ${SIGN_IN}`);
  } finally {
    passwordOutput.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}
