import { describe, expect, it } from "vitest";
import { ROUTER_DEFAULTS } from "./config.js";
import { handleBeforeModelResolve } from "./index.js";
import type { LogEntry } from "./logger.js";

describe("aj-router before_model_resolve hook", () => {
  it("rewrites model and provider based on the prompt", () => {
    const logged: LogEntry[] = [];
    const result = handleBeforeModelResolve(
      ROUTER_DEFAULTS,
      "Classify this email as spam.",
      (entry) => logged.push(entry),
    );
    expect(result).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.alias).toBe("speed");
  });

  it("returns undefined when the prompt is empty", () => {
    const result = handleBeforeModelResolve(ROUTER_DEFAULTS, "", () => {
      throw new Error("should not log empty prompts");
    });
    expect(result).toBeUndefined();
  });

  it("falls through (no override) when resolver rejects", () => {
    // Privileged default has blockExternal + non-local alias → rejection.
    const logged: LogEntry[] = [];
    const config = {
      ...ROUTER_DEFAULTS,
      defaultSensitivity: "privileged",
    };
    const result = handleBeforeModelResolve(config, "Hello.", (entry) => logged.push(entry));
    expect(result).toBeUndefined();
    expect(logged[0]?.rejected).toBe(true);
  });
});
