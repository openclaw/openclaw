import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSensitivePath, resolveSandboxPath } from "./sandbox-paths.js";

const home = os.homedir();

describe("isSensitivePath", () => {
  it("blocks ~/.openclaw/openclaw.json", () => {
    const result = isSensitivePath(path.join(home, ".openclaw", "openclaw.json"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.openclaw/credentials/", () => {
    const result = isSensitivePath(path.join(home, ".openclaw", "credentials", "token.json"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.openclaw/ itself", () => {
    const result = isSensitivePath(path.join(home, ".openclaw"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.ssh/id_rsa", () => {
    const result = isSensitivePath(path.join(home, ".ssh", "id_rsa"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.gnupg/", () => {
    const result = isSensitivePath(path.join(home, ".gnupg", "secring.gpg"));
    expect(result.sensitive).toBe(true);
  });

  it("blocks ~/.aws/credentials", () => {
    const result = isSensitivePath(path.join(home, ".aws", "credentials"));
    expect(result.sensitive).toBe(true);
  });

  it("allows normal workspace paths", () => {
    const result = isSensitivePath(path.join(home, "workspace", "project", "index.ts"));
    expect(result.sensitive).toBe(false);
  });

  it("allows paths outside home", () => {
    const result = isSensitivePath("/tmp/test.txt");
    expect(result.sensitive).toBe(false);
  });

  it("allows home directory root files", () => {
    const result = isSensitivePath(path.join(home, ".bashrc"));
    expect(result.sensitive).toBe(false);
  });
});

describe("resolveSandboxPath sensitive path blocking", () => {
  it("throws when accessing ~/.openclaw/ within sandbox", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: ".openclaw/openclaw.json",
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("throws when accessing ~/.ssh/ within sandbox", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: ".ssh/id_rsa",
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("allows normal paths within sandbox", () => {
    const result = resolveSandboxPath({
      filePath: "workspace/file.ts",
      cwd: home,
      root: home,
    });
    expect(result.resolved).toContain("workspace/file.ts");
  });

  it("allows skipping sensitive check when flag is set", () => {
    // Should not throw
    const result = resolveSandboxPath({
      filePath: ".openclaw/openclaw.json",
      cwd: home,
      root: home,
      skipSensitiveCheck: true,
    });
    expect(result.resolved).toContain(".openclaw/openclaw.json");
  });

  it("blocks absolute paths targeting sensitive dirs", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: path.join(home, ".openclaw", "credentials", "key.json"),
        cwd: home,
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });

  it("blocks tilde-expanded paths targeting sensitive dirs", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: "~/.openclaw/openclaw.json",
        cwd: "/tmp",
        root: home,
      }),
    ).toThrow(/sensitive directory/);
  });
});
