// Covers agent image-sanitization config limits.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";

describe("image sanitization config", () => {
  it("defaults when no config value exists", () => {
    expect(resolveImageSanitizationLimits(undefined)).toStrictEqual({});
    expect(resolveImageSanitizationLimits({ agents: { defaults: {} } })).toStrictEqual({});
  });

  it("reads agents.defaults.imageMaxDimensionPx", () => {
    expect(
      resolveImageSanitizationLimits({
        agents: { defaults: { imageMaxDimensionPx: 1600 } },
      } satisfies OpenClawConfig),
    ).toEqual({ maxDimensionPx: 1600 });
  });
});
