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
  let dir: string;
  const createSecretFile = (fileName: string, contents: string) => {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
    vi.stubEnv("LINE_CHANNEL_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

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

    expect(resolveLineAccount({ cfg })).toMatchObject({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: true,
      channelAccessToken: "override-token",
      channelSecret: "override-secret",
      name: "Test Bot",
      tokenSource: "config",
    });
  });

  it("resolves account from environment variables", () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
    vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");

    expect(resolveLineAccount({ cfg: withLine({ enabled: true }) })).toMatchObject({
      channelAccessToken: "env-token",
      channelSecret: "env-secret",
      tokenSource: "env",
    });
  });

  it("resolves named account credentials from account-level files", () => {
    const business = {
      tokenFile: createSecretFile("business-token.txt", "business-file-token\n"),
      secretFile: createSecretFile("business-secret.txt", "business-file-secret\n"),
    };
    const cfg = withLine({ accounts: { business } });

    expect(resolveLineAccount({ cfg, accountId: "business" })).toMatchObject({
      channelAccessToken: "business-file-token",
      enabled: true,
      channelSecret: "business-file-secret",
      tokenSource: "file",
    });
  });

  it.runIf(process.platform !== "win32")(
    "marks symlinked token and secret files configured-unavailable",
    () => {
      const tokenLink = path.join(dir, "token-link.txt");
      const secretLink = path.join(dir, "secret-link.txt");
      fs.symlinkSync(createSecretFile("token.txt", "file-token\n"), tokenLink);
      fs.symlinkSync(createSecretFile("secret.txt", "file-secret\n"), secretLink);
      const account = resolveLineAccount({
        cfg: withLine({ tokenFile: tokenLink, secretFile: secretLink }),
      });
      expect(account).toMatchObject({
        tokenStatus: "configured_unavailable",
        signingSecretStatus: "configured_unavailable",
      });
      expect(account.credentialDiagnostics).toEqual(
        ["tokenFile", "secretFile"].map((key) => ({
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: `channels.line.${key}`,
          reason: "symlink",
        })),
      );
      expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(dir);
    },
  );

  it("does not fall through when an explicit credential file is missing", () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
    vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");
    const tokenFile = createSecretFile("missing-token.txt", "unused");
    fs.rmSync(tokenFile);
    expect(
      resolveLineAccount({ cfg: withLine({ tokenFile, channelSecret: "test-channel-secret" }) }),
    ).toMatchObject({
      channelAccessToken: "",
      tokenStatus: "configured_unavailable",
      tokenSource: "file",
    });
  });
  it("preserves configured named-account insertion order", () => {
    expect(listLineAccountIds(withLine({ accounts: { work: {}, alerts: {} } }))).toEqual([
      "work",
      "alerts",
    ]);
  });
});
