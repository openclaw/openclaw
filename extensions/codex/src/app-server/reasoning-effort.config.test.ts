import { describe, expect, it } from "vitest";
import { buildCodexRuntimeThreadConfig } from "./thread-requests.js";

describe("native Codex reasoning-effort config", () => {
  it.for([true, false])("defaults on with native code mode %s", (nativeCodeModeEnabled) => {
    const config = buildCodexRuntimeThreadConfig(undefined, { nativeCodeModeEnabled });
    expect(config["features.reasoning_effort_override"]).toBe(true);
    expect(config["features.goals"]).toBe(false);
    expect(config["tools.update_plan.enabled"]).toBe(false);
    if (!nativeCodeModeEnabled) {
      expect(config["features.code_mode"]).toBe(false);
      expect(config["features.code_mode_only"]).toBe(false);
    }
  });

  it.for([true, false])(
    "retains explicit opt-out with native code mode %s",
    (nativeCodeModeEnabled) => {
      const config = buildCodexRuntimeThreadConfig(
        { "features.reasoning_effort_override": false, "features.goals": true },
        { nativeCodeModeEnabled },
      );
      expect(config["features.reasoning_effort_override"]).toBe(false);
      expect(config["features.goals"]).toBe(false);
      expect(config["tools.update_plan.enabled"]).toBe(false);
    },
  );
});
