import path from "node:path";
import { describe, expect, it } from "vitest";
import { findPluginImportBoundaryViolations } from "./check-plugin-import-boundaries.ts";

const repoRoot = "/Users/thoffman/openclaw";

function extensionFile(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

describe("findPluginImportBoundaryViolations", () => {
  it("allows same-extension relative imports", () => {
    const violations = findPluginImportBoundaryViolations(
      'import { helper } from "../shared/helper.js";',
      extensionFile("extensions/demo/src/feature/index.ts"),
    );
    expect(violations).toEqual([]);
  });

  it("allows plugin-sdk imports", () => {
    const violations = findPluginImportBoundaryViolations(
      'import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";',
      extensionFile("extensions/demo/src/feature/index.ts"),
    );
    expect(violations).toEqual([]);
  });

  it("rejects direct core imports", () => {
    const violations = findPluginImportBoundaryViolations(
      'import { loadConfig } from "../../../src/config/config.js";',
      extensionFile("extensions/demo/src/feature/index.ts"),
    );
    expect(violations).toEqual([
      expect.objectContaining({
        reason: "relative_escape",
        specifier: "../../../src/config/config.js",
      }),
    ]);
  });

  it("rejects cross-extension source imports", () => {
    const violations = findPluginImportBoundaryViolations(
      'import { helper } from "../../other-plugin/src/helper.js";',
      extensionFile("extensions/demo/src/feature/index.ts"),
    );
    expect(violations).toEqual([
      expect.objectContaining({
        reason: "cross_extension_import",
        specifier: "../../other-plugin/src/helper.js",
      }),
    ]);
  });

  it("rejects host-internal bare imports outside the SDK", () => {
    const violations = findPluginImportBoundaryViolations(
      'import { loadConfig } from "openclaw/src/config/config.js";',
      extensionFile("extensions/demo/src/feature/index.ts"),
    );
    expect(violations).toEqual([
      expect.objectContaining({
        reason: "core_internal_import",
        specifier: "openclaw/src/config/config.js",
      }),
    ]);
  });
});
