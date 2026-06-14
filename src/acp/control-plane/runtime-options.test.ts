/** Tests runtime config-option serialization against advertised backend keys. */
import { describe, expect, it } from "vitest";
import {
  buildRuntimeConfigOptionPairs,
  retainUnchangedAppliedRuntimeOptions,
} from "./runtime-options.js";

describe("buildRuntimeConfigOptionPairs timeout advertisement", () => {
  it("omits the timeout pair when advertised keys exclude every timeout alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "thinking",
      "approval_policy",
    ]);
    expect(pairs).toEqual([]);
  });

  it("keeps the timeout pair when advertised keys include `timeout`", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, ["model", "timeout"]);
    expect(pairs).toEqual([["timeout", "60"]]);
  });

  it("keeps the timeout pair using the advertised `timeout_seconds` alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "timeout_seconds",
    ]);
    expect(pairs).toEqual([["timeout_seconds", "60"]]);
  });

  it("keeps the timeout pair when advertised keys are unknown (empty or undefined)", () => {
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 })).toEqual([["timeout", "60"]]);
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [])).toEqual([["timeout", "60"]]);
  });

  it("does not affect model or thinking emission when only timeout is unadvertised", () => {
    const pairs = buildRuntimeConfigOptionPairs(
      { model: "claude-sonnet-4.6", thinking: "high", timeoutSeconds: 60 },
      ["model", "thinking"],
    );
    expect(pairs).toEqual([
      ["model", "claude-sonnet-4.6"],
      ["thinking", "high"],
    ]);
  });
});

describe("retainUnchangedAppliedRuntimeOptions", () => {
  it("keeps the startup baseline when a later update only adds post-start controls", () => {
    const retained = retainUnchangedAppliedRuntimeOptions({
      applied: {
        model: "deepseek/deepseek-v4-pro",
        thinking: "high",
        cwd: "/work",
      },
      persisted: {
        model: "deepseek/deepseek-v4-pro",
        thinking: "high",
        cwd: "/work",
        permissionProfile: "strict",
        timeoutSeconds: 120,
      },
    });
    expect(retained).toEqual({
      model: "deepseek/deepseek-v4-pro",
      thinking: "high",
      cwd: "/work",
    });
  });

  it("drops entries whose persisted value changed so the next turn reapplies them", () => {
    const retained = retainUnchangedAppliedRuntimeOptions({
      applied: { model: "old-model", thinking: "high" },
      persisted: { model: "new-model", thinking: "high" },
    });
    expect(retained).toEqual({ thinking: "high" });
  });

  it("retains only backend extras whose values still match", () => {
    const retained = retainUnchangedAppliedRuntimeOptions({
      applied: { backendExtras: { kept: "1", changed: "old", removed: "x" } },
      persisted: { backendExtras: { kept: "1", changed: "new" } },
    });
    expect(retained).toEqual({ backendExtras: { kept: "1" } });
  });

  it("returns an empty baseline when nothing was applied yet", () => {
    expect(
      retainUnchangedAppliedRuntimeOptions({
        applied: undefined,
        persisted: { permissionProfile: "strict" },
      }),
    ).toEqual({});
  });
});
