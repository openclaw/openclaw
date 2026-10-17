import * as childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGrokBotAccessToken } from "./auth.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

let homeDir: string;
const execFile = vi.mocked(childProcess.execFile);
// Independent synthetic Chromium v10 ciphertext, never a real login.
const encrypted = "djEw2nfvkGFqd/gN2C7cP0A3TcIxSb+wnVi0zgjkAaeXvRY=";

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-auth-test-"));
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(homeDir, { recursive: true, force: true });
});

async function saveAccounts(active: string | null) {
  const directory = path.join(homeDir, "Library/Application Support/Grok Bot");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "sand-secrets.json"),
    JSON.stringify({
      version: 1,
      "cursor-accounts": JSON.stringify({
        active,
        accounts: {
          other: { "cursor-access-token": "not-the-selected-account" },
          selected: {
            "cursor-access-token": encrypted,
            "cursor-refresh-token": "must-not-be-used",
          },
        },
      }),
    }),
  );
}

describe("Grok Bot explicit credential resolution", () => {
  it("uses the supplied environment token without touching native credentials", async () => {
    expect(
      await resolveGrokBotAccessToken({
        env: { GROK_BOT_ACCESS_TOKEN: " supplied-session " },
        platform: "linux",
        homeDir,
      }),
    ).toBe("supplied-session");
    expect(execFile).not.toHaveBeenCalled();
    await expect(
      resolveGrokBotAccessToken({ env: {}, platform: "linux", homeDir }),
    ).rejects.toThrow(/GROK_BOT_ACCESS_TOKEN/);
  });

  it("decrypts only the active saved account with one Keychain call", async () => {
    await saveAccounts("selected");
    const password = Buffer.from("synthetic-keychain-password\n");
    execFile.mockImplementation((...args) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(null, password, Buffer.alloc(0));
      }
      return {} as childProcess.ChildProcess;
    });
    expect(await resolveGrokBotAccessToken({ env: {}, platform: "darwin", homeDir })).toBe(
      "synthetic-active-session",
    );
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Grok Bot Safe Storage", "-w"],
      expect.objectContaining({ encoding: "buffer", timeout: 30_000 }),
      expect.any(Function),
    );
    expect(password.every((byte) => byte === 0)).toBe(true);
  });

  it("does not search other accounts when there is no active sign-in", async () => {
    await saveAccounts(null);
    await expect(
      resolveGrokBotAccessToken({ env: {}, platform: "darwin", homeDir }),
    ).rejects.toThrow(/active Grok Bot sign-in/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports Keychain recovery without exposing subprocess output", async () => {
    await saveAccounts("selected");
    execFile.mockImplementation((...args) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        callback(
          Object.assign(new Error("private subprocess output"), { cmd: "/usr/bin/security" }),
          Buffer.alloc(0),
          Buffer.from("private stderr"),
        );
      }
      return {} as childProcess.ChildProcess;
    });
    await expect(
      resolveGrokBotAccessToken({ env: {}, platform: "darwin", homeDir }),
    ).rejects.toThrow(/^Grok Bot's macOS Keychain could not be read\./);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
