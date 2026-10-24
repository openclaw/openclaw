import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectZaloAccount,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";
import { zaloPlugin } from "./channel.js";
import { resolveZaloToken } from "./token.js";
import type { ZaloConfig } from "./types.js";

const config = (zalo: ZaloConfig): OpenClawConfig => ({ channels: { zalo } });

afterEach(() => vi.unstubAllEnvs());

describe("resolveZaloAccount", () => {
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = config({
      botToken: "default-token",
      accounts: { work: { enabled: false, botToken: "work-token" } },
    });

    expect(listZaloAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZaloAccountId(cfg)).toBe("default");
    expect(resolveZaloAccount({ cfg, accountId: "default" }).enabled).toBe(true);
  });

  it("carries account-owned unavailable credential diagnostics into the resolved account", () => {
    const tokenFile = "/private/zalo-resolved-account-token";
    const resolved = resolveZaloAccount({
      cfg: config({ botToken: "lower-priority-token", accounts: { work: { tokenFile } } }),
      accountId: "work",
    });

    expect(resolved).toMatchObject({
      token: "",
      tokenSource: "configFile",
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.zalo.accounts.work.tokenFile",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(resolved.credentialDiagnostics)).not.toContain(tokenFile);
  });
  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
  };

  it.each([
    { botToken: "bot-token", webhookUrl: undefined, mode: "polling" },
    {
      botToken: unresolvedRef,
      webhookUrl: "https://bot.example.com/zalo",
      mode: "webhook",
    },
  ])("reports configured $mode inspection", async (entry) => {
    const cfg = config({
      accounts: {
        work: { botToken: entry.botToken, webhookUrl: entry.webhookUrl, dmPolicy: "open" },
      },
    });
    const account = inspectZaloAccount({ cfg, accountId: "work" });
    expect(await zaloPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: true,
      mode: entry.mode,
      dmPolicy: "open",
    });
  });

  it("keeps direct account resolution strict", () => {
    expect(() => resolveZaloAccount({ cfg: config({ botToken: unresolvedRef }) })).toThrow(
      /unresolved SecretRef/,
    );
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "lower-precedence-token");
    const account = inspectZaloAccount({ cfg: config({ botToken: unresolvedRef }) });
    expect(account).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    });
  });
});

function expectUnavailableFile(
  result: ReturnType<typeof resolveZaloToken>,
  configPath: string,
  reason?: string,
) {
  const diagnostic = {
    code: "CREDENTIAL_FILE_UNAVAILABLE",
    path: configPath,
    ...(reason ? { reason } : {}),
  };
  expect(result).toMatchObject({
    token: "",
    source: "configFile",
    status: "configured_unavailable",
    credentialDiagnostics: [diagnostic],
  });
}

function createSymlinkedFile(targetPath: string, linkPath: string): boolean {
  try {
    fs.writeFileSync(targetPath, "file-token\n", "utf8");
    fs.symlinkSync(targetPath, linkPath, "file");
    return true;
  } catch {
    fs.rmSync(linkPath, { force: true });
    fs.rmSync(targetPath, { force: true });
    return false;
  }
}

describe("resolveZaloToken", () => {
  it("uses configured defaultAccount token when accountId is omitted", () => {
    const res = resolveZaloToken({
      defaultAccount: "work",
      botToken: "top-level-token",
      accounts: { work: { botToken: "work-token" } },
    });
    expect(res).toMatchObject({ token: "work-token", source: "config" });
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    expect(
      resolveZaloToken(
        { botToken: "top-level-token", accounts: { work: { botToken: "" } } },
        "work",
      ),
    ).toMatchObject({ token: "", source: "none" });
  });

  it("does not fall back from an unavailable top-level token file to the environment", () => {
    const tokenFile = "/private/zalo-missing-root-token";
    vi.stubEnv("ZALO_BOT_TOKEN", "lower-priority-env-token");

    const result = resolveZaloToken({ tokenFile });

    expectUnavailableFile(result, "channels.zalo.tokenFile", "not-found");
    expect(JSON.stringify(result)).not.toContain(tokenFile);
  });

  it("honors an unavailable account token file after an explicitly blank account bot token", () => {
    const result = resolveZaloToken(
      {
        botToken: "lower-priority-top-level-token",
        accounts: { work: { botToken: "", tokenFile: "/private/zalo-blank-account-token" } },
      },
      "work",
    );

    expectUnavailableFile(result, "channels.zalo.accounts.work.tokenFile");
  });

  it("rejects symlinked token files", ({ skip }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-zalo-token-"));
    try {
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      if (!createSymlinkedFile(tokenFile, tokenLink)) {
        skip("file symlinks are unavailable on this host");
      }

      const result = resolveZaloToken({ tokenFile: tokenLink });
      expectUnavailableFile(result, "channels.zalo.tokenFile", "symlink");
      expect(JSON.stringify(result)).not.toContain(tokenLink);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
