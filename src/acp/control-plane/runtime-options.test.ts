import { describe, expect, it } from "vitest";
import { buildRuntimeConfigOptionPairs } from "./runtime-options.js";

describe("buildRuntimeConfigOptionPairs timeout advertisement", () => {
  it("omits the timeout pair even when advertised keys exclude every timeout alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "thinking",
      "approval_policy",
    ]);
    expect(pairs).toEqual([]);
  });

  it("omits the timeout pair when advertised keys include `timeout`", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, ["model", "timeout"]);
    expect(pairs).toEqual([]);
  });

  it("omits the timeout pair using the advertised `timeout_seconds` alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "timeout_seconds",
    ]);
    expect(pairs).toEqual([]);
  });

  it("omits the timeout pair when advertised keys are unknown (empty or undefined)", () => {
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 })).toEqual([]);
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [])).toEqual([]);
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
