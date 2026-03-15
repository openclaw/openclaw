import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";

describe("normalizeSandboxHostPath", () => {
  it("normalizes dot segments and strips trailing slash", () => {
    expect(normalizeSandboxHostPath("/tmp/a/../b//")).toBe("/tmp/b");
  });
});

describe("resolveSandboxHostPathViaExistingAncestor", () => {
  it("keeps non-absolute paths unchanged", () => {
    expect(resolveSandboxHostPathViaExistingAncestor("relative/path")).toBe("relative/path");
  });

  it("resolves symlink parents when the final leaf does not exist", () => {
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
