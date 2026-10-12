// Line tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLineAccountIds, resolveLineAccount } from "./accounts.js";
import type { LineConfig } from "./types.js";

function withLine(line: LineConfig): OpenClawConfig {
  return { channels: { line } };
}

describe("LINE accounts", () => {
  const tempDirs: string[] = [];

  const createSecretFile = (fileName: string, contents: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
    vi.stubEnv("LINE_CHANNEL_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("resolveLineAccount", () => {
    it("resolves account from config", () => {
      const cfg = withLine({
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        name: "Test Bot",
        accounts: {
          default: { channelAccessToken: "override-token", channelSecret: "override-secret" },
        },
      });

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("override-token");
      expect(account.channelSecret).toBe("override-secret");
      expect(account.name).toBe("Test Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
      vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");

      const cfg = withLine({
        enabled: true,
      });

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("env-token");
      expect(account.channelSecret).toBe("env-secret");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account credentials from account-level files", () => {
      const cfg = withLine({
        accounts: {
          business: {
            tokenFile: createSecretFile("business-token.txt", "business-file-token\n"),
            secretFile: createSecretFile("business-secret.txt", "business-file-secret\n"),
          },
        },
      });

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.channelAccessToken).toBe("business-file-token");
      expect(account.enabled).toBe(true);
      expect(account.channelSecret).toBe("business-file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it.runIf(process.platform !== "win32")(
      "marks symlinked token and secret files configured-unavailable",
      () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
        tempDirs.push(dir);
        const tokenFile = path.join(dir, "token.txt");
        const tokenLink = path.join(dir, "token-link.txt");
        const secretFile = path.join(dir, "secret.txt");
        const secretLink = path.join(dir, "secret-link.txt");
        fs.writeFileSync(tokenFile, "file-token\n", "utf8");
        fs.writeFileSync(secretFile, "file-secret\n", "utf8");
        fs.symlinkSync(tokenFile, tokenLink);
        fs.symlinkSync(secretFile, secretLink);

        const cfg: OpenClawConfig = {
          channels: {
            line: {
              tokenFile: tokenLink,
              secretFile: secretLink,
            },
          },
        };

        const account = resolveLineAccount({ cfg });
        expect(account.tokenStatus).toBe("configured_unavailable");
        expect(account.signingSecretStatus).toBe("configured_unavailable");
        expect(account.credentialDiagnostics).toEqual([
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.line.tokenFile",
            reason: "symlink",
          },
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.line.secretFile",
            reason: "symlink",
          },
        ]);
        expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(dir);
      },
    );

    it("does not fall through when an explicit credential file is missing", () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
      vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");
      const tokenFile = createSecretFile("missing-token.txt", "unused");
      fs.rmSync(tokenFile);
      const cfg = withLine({
        tokenFile,
        channelSecret: "test-channel-secret",
      });

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.tokenSource).toBe("file");
    });
  });

  describe("listLineAccountIds", () => {
    it("preserves configured named-account insertion order", () => {
      expect(
        listLineAccountIds({
          channels: {
            line: {
              accounts: { work: {}, alerts: {} },
            },
          },
        }),
      ).toEqual(["work", "alerts"]);
    });
  });
});
