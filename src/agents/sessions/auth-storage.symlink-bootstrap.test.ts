import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "./auth-storage.js";

describe("auth-storage bootstrap does not follow a symlink at auth.json", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it("creates a real file in place instead of writing through a planted symlink", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "auth-symlink-"));
    const agentDir = join(tmpRoot, "agent");
    const authPath = join(agentDir, "auth.json");
    const victimPath = join(tmpRoot, "victim-secret.json");

    mkdirSync(agentDir, { recursive: true });
    symlinkSync(victimPath, authPath);

    AuthStorage.create(authPath);

    expect(existsSync(victimPath)).toBe(false);
    expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(authPath).isFile()).toBe(true);
    expect(readFileSync(authPath, "utf-8")).toBe("{}");
  });
});
