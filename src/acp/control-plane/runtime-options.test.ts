import { describe, expect, it } from "vitest";
import {
  buildRuntimeConfigOptionPairs,
  inferRuntimeOptionPatchFromConfigOption,
} from "./runtime-options.js";

describe("buildRuntimeConfigOptionPairs", () => {
  it("returns an empty list when only timeoutSeconds is set", () => {
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 120 })).toEqual([]);
  });

  it("emits model, thinking, approval_policy without a timeout pair", () => {
    const pairs = buildRuntimeConfigOptionPairs({
      model: "claude-3.7",
      thinking: "high",
      permissionProfile: "strict",
      timeoutSeconds: 120,
    });
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["model", "claude-3.7"],
        ["thinking", "high"],
        ["approval_policy", "strict"],
      ]),
    );
    expect(pairs).not.toContainEqual(expect.arrayContaining(["timeout"]));
  });

  it("preserves backendExtras with key 'timeout' as the explicit escape hatch", () => {
    expect(buildRuntimeConfigOptionPairs({ backendExtras: { timeout: "999" } })).toEqual([
      ["timeout", "999"],
    ]);
  });

  it("returns an empty list for empty options", () => {
    expect(buildRuntimeConfigOptionPairs({})).toEqual([]);
  });
});

describe("inferRuntimeOptionPatchFromConfigOption", () => {
  it("still routes inbound 'timeout' updates back to runtimeOptions.timeoutSeconds", () => {
    expect(inferRuntimeOptionPatchFromConfigOption("timeout", "120")).toEqual({
      timeoutSeconds: 120,
    });
  });

  it("also accepts the timeout_seconds spelling", () => {
    expect(inferRuntimeOptionPatchFromConfigOption("timeout_seconds", "60")).toEqual({
      timeoutSeconds: 60,
    });
  });
});
