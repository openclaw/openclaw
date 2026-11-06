// Sandbox host path tests cover cross-platform path normalization and symlink
// resolution used before Docker bind mounts are constructed.
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  getSandboxHostPathPolicyKey,
  isSandboxHostPathAbsolute,
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("normalizeSandboxHostPath", () => {
  it("normalizes dot segments and strips trailing slash", () => {
    expect(normalizeSandboxHostPath("/tmp/a/../b//")).toBe("/tmp/b");
  });

  it("preserves meaningful whitespace in host path identity", () => {
    expect(normalizeSandboxHostPath("/tmp/project ")).toBe("/tmp/project ");
    expect(getSandboxHostPathPolicyKey("/tmp/project ")).not.toBe(
      getSandboxHostPathPolicyKey("/tmp/project"),
    );
    expect(isSandboxHostPathAbsolute(" /tmp/project")).toBe(false);
  });

  it("normalizes Windows drive-letter paths without losing the drive root", () => {
    expect(normalizeSandboxHostPath("c:\\Users\\Kai\\..\\Project\\")).toBe("C:/Users/Project");
    expect(normalizeSandboxHostPath("\\\\?\\c:\\Users\\Kai\\..\\Project\\")).toBe(
      "C:/Users/Project",
    );
    expect(normalizeSandboxHostPath("d:/")).toBe("D:/");
  });

  it.runIf(process.platform !== "win32")(
    "keeps literal POSIX backslashes distinct from separators",
    () => {
      expect(normalizeSandboxHostPath("/tmp/a\\b/./leaf")).toBe("/tmp/a\\b/leaf");
      expect(getSandboxHostPathPolicyKey("/tmp/a\\b")).not.toBe(
        getSandboxHostPathPolicyKey("/tmp/a/b"),
      );
    },
  );
});

describe("isSandboxHostPathAbsolute", () => {
  it("accepts POSIX and drive-absolute Windows paths", () => {
    expect(isSandboxHostPathAbsolute("/tmp/project")).toBe(true);
    expect(isSandboxHostPathAbsolute("C:/Users/kai/project")).toBe(true);
    expect(isSandboxHostPathAbsolute("C:\\Users\\kai\\project")).toBe(true);
  });

  it("rejects relative paths, named volumes, and drive-relative Windows paths", () => {
    expect(isSandboxHostPathAbsolute("relative/path")).toBe(false);
    expect(isSandboxHostPathAbsolute("my-volume")).toBe(false);
    expect(isSandboxHostPathAbsolute("C:relative\\path")).toBe(false);
  });
});

describe("getSandboxHostPathPolicyKey", () => {
  it("compares Windows drive-letter paths case-insensitively", () => {
    expect(getSandboxHostPathPolicyKey("c:\\Users\\Kai\\.SSH\\config")).toBe(
      "c:/users/kai/.ssh/config",
    );
  });
});

describe("resolveSandboxHostPathViaExistingAncestor", () => {
  it.runIf(process.platform !== "win32")(
    "preserves literal root bytes through realpath and missing leaves",
    () => {
      const root = realpathSync(tempDirs.make("openclaw-host-paths-"));
      const literal = join(root, "a\\b");
      const slash = join(root, "a/b");
      mkdirSync(literal);
      mkdirSync(slash, { recursive: true });
      symlinkSync(literal, join(root, "alias"));
      expect(resolveSandboxHostPathViaExistingAncestor(join(root, "alias/missing"))).toBe(
        join(literal, "missing"),
      );
      expect(resolveSandboxHostPathViaExistingAncestor(join(slash, "missing"))).toBe(
        join(slash, "missing"),
      );
    },
  );

  it("keeps non-absolute paths unchanged", () => {
    expect(resolveSandboxHostPathViaExistingAncestor("relative/path")).toBe("relative/path");
  });

  it("normalizes Windows paths without resolving them through POSIX cwd on non-Windows hosts", () => {
    // Cross-platform config can carry Windows paths on macOS/Linux; treating
    // them as POSIX relatives would corrupt the mount policy key.
    if (process.platform === "win32") {
      return;
    }

    expect(resolveSandboxHostPathViaExistingAncestor("C:/Users/kai/project")).toBe(
      "C:/Users/kai/project",
    );
  });

  it("resolves symlink parents when the final leaf does not exist", () => {
    // Mount checks need the real parent path even when Docker will create the
    // final missing leaf later.
    if (process.platform === "win32") {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "openclaw-host-paths-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(workspace, "alias-out");
    symlinkSync(outside, link);

    const unresolved = join(link, "missing-leaf");
    const resolved = resolveSandboxHostPathViaExistingAncestor(unresolved);
    expect(resolved).toBe(join(realpathSync.native(outside), "missing-leaf"));
  });
});
