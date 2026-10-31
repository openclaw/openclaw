import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
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
const unresolvedRef = {
  source: "env" as const,
  provider: "default",
  id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
};

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

  it.each([
    { botToken: "bot-token", webhookUrl: undefined, mode: "polling" },
    { botToken: unresolvedRef, webhookUrl: "https://bot.example.com/zalo", mode: "webhook" },
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
  result: ReturnType<typeof resolveZaloToken> | ReturnType<typeof resolveZaloAccount>,
  path: string,
  reason: string,
) {
  expect(result).toMatchObject({
    token: "",
    ...("source" in result
      ? { source: "configFile", status: "configured_unavailable" }
      : { tokenSource: "configFile", tokenStatus: "configured_unavailable" }),
    credentialDiagnostics: [{ code: "CREDENTIAL_FILE_UNAVAILABLE", path, reason }],
  });
}

describe("resolveZaloToken", () => {
  it.each([
    [undefined, "work-token", "config"],
    ["work", "", "none"],
  ] as const)("resolves named token with accountId=%s and token=%j", (accountId, token, source) => {
    const res = resolveZaloToken(
      {
        defaultAccount: "work",
        botToken: "top-level-token",
        accounts: { work: { botToken: token } },
      },
      accountId,
    );
    expect(res).toMatchObject({ token, source });
  });

  it.each([
    ["default", false],
    ["work", false],
    ["work", true],
  ] as const)(
    "preserves unavailable file diagnostics for %s (blank token=%s)",
    (accountId, blank) => {
      const tokenFile = "/private/zalo-missing-token";
      vi.stubEnv("ZALO_BOT_TOKEN", "lower-priority-env-token");
      const result = resolveZaloAccount({
        cfg: config(
          accountId === "default"
            ? { tokenFile }
            : {
                botToken: "lower-priority-top-level-token",
                accounts: { work: { tokenFile, ...(blank ? { botToken: "" } : {}) } },
              },
        ),
        accountId,
      });
      expectUnavailableFile(
        result,
        accountId === "default"
          ? "channels.zalo.tokenFile"
          : "channels.zalo.accounts.work.tokenFile",
        "not-found",
      );
      expect(JSON.stringify(result.credentialDiagnostics)).not.toContain(tokenFile);
    },
  );

  it("rejects symlinked token files", ({ skip }) => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openclaw-zalo-token-"));
    try {
      const tokenFile = nodePath.join(dir, "token.txt");
      const tokenLink = nodePath.join(dir, "token-link.txt");
      try {
        fs.writeFileSync(tokenFile, "file-token\n", "utf8");
        fs.symlinkSync(tokenFile, tokenLink, "file");
      } catch {
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
