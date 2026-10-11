// Sandbox host path tests cover cross-platform path normalization and symlink
// resolution used before Docker bind mounts are constructed.
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("normalizeSandboxHostPath", () => {
  it("normalizes Windows drive-letter paths without losing the drive root", () => {
    expect(normalizeSandboxHostPath("c:\\Users\\Kai\\..\\Project\\")).toBe("C:/Users/Project");
    expect(normalizeSandboxHostPath("\\\\?\\c:\\Users\\Kai\\..\\Project\\")).toBe(
      "C:/Users/Project",
    );
    expect(normalizeSandboxHostPath("d:/")).toBe("D:/");
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
});
