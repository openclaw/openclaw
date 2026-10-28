import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readManagedGitLabProfileToken,
  writeManagedGitLabProfileFiles,
} from "./gitlab-tool-profile-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed glab profile custody", () => {
  it("writes only an isolated private glab config for the exact issuer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-profile-test-"));
    roots.push(root);
    const profileDir = path.join(root, "system", "glp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await writeManagedGitLabProfileFiles(profileDir, {
      issuer: "https://gitlab.example:8443",
      login: "verified",
      token: "synthetic-token",
    });
    expect(await readManagedGitLabProfileToken(profileDir, "https://gitlab.example:8443")).toBe(
      "synthetic-token",
    );
    expect(
      await readManagedGitLabProfileToken(profileDir, "https://other.example"),
    ).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.stat(profileDir)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(profileDir, "config.yml"))).mode & 0o077).toBe(0);
    }
  });

  it("refuses a symlinked credential file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-profile-test-"));
    roots.push(root);
    const profileDir = path.join(root, "system", "glp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await writeManagedGitLabProfileFiles(profileDir, {
      issuer: "https://gitlab.com",
      login: "verified",
      token: "synthetic-token",
    });
    await fs.rename(path.join(profileDir, "config.yml"), path.join(root, "moved.yml"));
    await fs.symlink(path.join(root, "moved.yml"), path.join(profileDir, "config.yml"));
    expect(await readManagedGitLabProfileToken(profileDir, "https://gitlab.com")).toBeUndefined();
  });
});
