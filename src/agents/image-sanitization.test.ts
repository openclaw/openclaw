// Covers agent image-sanitization limit config normalization.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_IMAGE_MAX_INPUT_PIXELS,
  MAX_IMAGE_MAX_INPUT_PIXELS,
  resolveImageInputPixelLimit,
} from "./image-input-limits.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";

describe("image input pixel limit config", () => {
  it("defaults to the existing 25 MP safety limit", () => {
    expect(resolveImageInputPixelLimit(undefined)).toBe(DEFAULT_IMAGE_MAX_INPUT_PIXELS);
    expect(resolveImageInputPixelLimit({ agents: { defaults: {} } } as OpenClawConfig)).toBe(
      DEFAULT_IMAGE_MAX_INPUT_PIXELS,
    );
  });

  it("accepts a configured limit up to the safe 50 MP maximum", () => {
    expect(
      resolveImageInputPixelLimit({
        agents: { defaults: { imageMaxInputPixels: MAX_IMAGE_MAX_INPUT_PIXELS } },
      } as OpenClawConfig),
    ).toBe(50_000_000);
  });

  it("falls back to the safe default for invalid runtime config", () => {
    expect(
      resolveImageInputPixelLimit({
        agents: { defaults: { imageMaxInputPixels: MAX_IMAGE_MAX_INPUT_PIXELS + 1 } },
      } as OpenClawConfig),
    ).toBe(DEFAULT_IMAGE_MAX_INPUT_PIXELS);
  });
});

describe("image sanitization config", () => {
  it("defaults when no config value exists", () => {
    expect(resolveImageSanitizationLimits(undefined)).toStrictEqual({});
    expect(
      resolveImageSanitizationLimits({ agents: { defaults: {} } } as unknown as OpenClawConfig),
    ).toStrictEqual({});
  });

  it("reads and normalizes agents.defaults.imageMaxDimensionPx", () => {
    expect(
      resolveImageSanitizationLimits({
        agents: { defaults: { imageMaxDimensionPx: 1600.9 } },
      } as unknown as OpenClawConfig),
    ).toEqual({ maxDimensionPx: 1600 });
  });
});
