import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import { resolveTelegramToken } from "./token.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

describe("resolveTelegramToken", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-token-"));
    tempDirs.push(dir);
    return dir;
  }

  function createTokenFile(fileName: string, contents = "file-token\n"): string {
    const dir = createTempDir();
    const tokenFile = path.join(dir, fileName);
    fs.writeFileSync(tokenFile, contents, "utf-8");
    return tokenFile;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "prefers config token over env",
      envToken: "env-token",
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      expected: { token: "cfg-token", source: "config" },
    },
    {
      name: "uses env token when config is missing",
      envToken: "env-token",
      cfg: {
        channels: { telegram: {} },
      } as OpenClawConfig,
      expected: { token: "env-token", source: "env" },
    },
    {
      name: "uses tokenFile when configured",
      envToken: "",
      cfg: {
        channels: { telegram: { tokenFile: "" } },
      } as OpenClawConfig,
      resolveCfg: () =>
        ({
          channels: { telegram: { tokenFile: createTokenFile("token.txt") } },
        }) as OpenClawConfig,
      expected: { token: "file-token", source: "tokenFile" },
    },
    {
      name: "falls back to config token when no env or tokenFile",
      envToken: "",
      cfg: {
        channels: { telegram: { botToken: "cfg-token" } },
      } as OpenClawConfig,
      expected: { token: "cfg-token", source: "config" },
    },
  ])("$name", ({ envToken, cfg, resolveCfg, expected }) => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", envToken);
    const res = resolveTelegramToken(resolveCfg ? resolveCfg() : cfg);
    expect(res).toEqual(expected);
  });

  it.runIf(process.platform !== "win32")("rejects symlinked tokenFile paths", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "token.txt");
    const tokenLink = path.join(dir, "token-link.txt");
    fs.writeFileSync(tokenFile, "file-token\n", "utf-8");
    fs.symlinkSync(tokenFile, tokenLink);

    const cfg = { channels: { telegram: { tokenFile: tokenLink } } } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall back to config when tokenFile is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = createTempDir();
    const tokenFile = path.join(dir, "missing-token.txt");
    const cfg = {
      channels: { telegram: { tokenFile, botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves per-account tokens when the config account key casing doesn't match routing normalization", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            // Note the mixed-case key; runtime accountId is normalized.
            careyNotifications: { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "careynotifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "top-level-token",
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("top-level-token");
    expect(res.source).toBe("config");
  });

  it("uses account-level tokenFile before top-level fallbacks", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "top-level-token",
          tokenFile: createTokenFile("top-level-token.txt", "top-level-file-token\n"),
          accounts: {
            work: {
              tokenFile: createTokenFile("account-token.txt", "account-file-token\n"),
            },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("account-file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("falls back to top-level tokenFile for non-default accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          tokenFile: createTokenFile("token.txt"),
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("file-token");
    expect(res.source).toBe("tokenFile");
  });

  it("does not use env token for non-default accounts", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("does not fall through to channel-level token when non-default accountId is not in config", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: "wrong-bot-token",
          accounts: {
            knownBot: { botToken: "known-bot-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "unknownBot" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("throws when botToken is an unresolved SecretRef object", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveTelegramToken(cfg)).toThrow(
      /channels\.telegram\.botToken: unresolved SecretRef/i,
    );
  });
});

describe("telegram update offset store", () => {
  it("persists and reloads the last update id", async () => {
    await withStateDirEnv("openclaw-telegram-", async () => {
      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();

      await writeTelegramUpdateOffset({
        accountId: "primary",
        updateId: 421,
      });

      expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBe(421);
    });
  });
});
