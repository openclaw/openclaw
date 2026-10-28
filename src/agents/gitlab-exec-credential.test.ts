import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitLabExecToken } from "./gitlab-exec-credential.js";

let root: string;
let profile: string;
const issuer = "https://gitlab.example.test";
const selected = "synthetic-selected-token";

async function writeConfig(source: string) {
  await fs.writeFile(path.join(profile, "config.yml"), source, { mode: 0o600 });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-credential-")));
  profile = path.join(root, "managed profile");
  await fs.mkdir(profile, { mode: 0o700 });
  await writeConfig(`hosts:\n  gitlab.example.test:\n    token: ${selected}\n`);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("GitLab exec credential custody", () => {
  it("reads only the exact configured HTTPS issuer host", async () => {
    await expect(readGitLabExecToken(profile, issuer)).resolves.toBe(selected);
    await expect(readGitLabExecToken(profile, "https://other.example.test")).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
  });

  it.each([
    { name: "missing hosts", source: `token: ${selected}\n` },
    { name: "wrong host", source: `hosts:\n  other.example.test:\n    token: ${selected}\n` },
    { name: "corrupt YAML", source: `hosts: [${selected}\n` },
    {
      name: "YAML aliases",
      source: `hosts:\n  gitlab.example.test: &identity\n    token: ${selected}\n  other.example.test: *identity\n`,
    },
    { name: "empty token", source: "hosts:\n  gitlab.example.test:\n    token: ''\n" },
  ])("rejects $name without leaking credential details", async ({ source }) => {
    await writeConfig(source);
    await expect(readGitLabExecToken(profile, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
    try {
      await readGitLabExecToken(profile, issuer);
    } catch (error) {
      expect(String(error)).not.toContain(selected);
      expect(String(error)).not.toContain(profile);
    }
  });

  it("rejects a symlinked or hard-linked config", async () => {
    const config = path.join(profile, "config.yml");
    const copy = path.join(root, "copy.yml");
    await fs.rename(config, copy);
    await fs.symlink(copy, config);
    await expect(readGitLabExecToken(profile, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
    await fs.rm(config);
    await fs.link(copy, config);
    await expect(readGitLabExecToken(profile, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
  });

  it("rejects a profile symlink or broad directory permissions", async () => {
    const alias = path.join(root, "profile alias");
    await fs.symlink(profile, alias);
    await expect(readGitLabExecToken(alias, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
    await fs.chmod(profile, 0o755);
    await expect(readGitLabExecToken(profile, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
  });

  it("rejects a public config file", async () => {
    await fs.chmod(path.join(profile, "config.yml"), 0o644);
    await expect(readGitLabExecToken(profile, issuer)).rejects.toThrow(
      "GitLab Identity credential is unavailable or insecure",
    );
  });
});
