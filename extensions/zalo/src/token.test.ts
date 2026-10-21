import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZaloToken } from "./token.js";

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
  afterEach(() => vi.unstubAllEnvs());

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
