import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatExtraPaths } from "./cli-runtime-common.js";

describe("formatExtraPaths", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prints evergreen policy with and without a glob pattern", () => {
    // Keep the display root outside the explicitly selected home on every OS.
    vi.stubEnv("OPENCLAW_HOME", path.resolve("openclaw-home-fixture"));
    const workspaceDir = path.resolve("openclaw-format-fixture");
    expect(
      formatExtraPaths(workspaceDir, [
        { path: "reference", evergreen: true },
        { path: "notes", pattern: "runbooks/**/*.md", evergreen: true },
      ]),
    ).toEqual([
      `${path.join(workspaceDir, "reference")} (evergreen)`,
      `${path.join(workspaceDir, "notes")} (pattern: runbooks/**/*.md, evergreen)`,
    ]);
  });
});
