import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAdvertisedModelId } from "./advertised-model.js";

const { availableModelIds } = JSON.parse(
  fs.readFileSync(new URL("../test/fixtures/cursor-model-catalog.json", import.meta.url), "utf8"),
) as { availableModelIds: string[] };

describe("resolveAdvertisedModelId", () => {
  it.each([
    ["composer-2.5[fast=true]", "composer-2.5[fast=true]"],
    ["composer-2.5", "composer-2.5[fast=true]"],
    ["xai/grok-4.5", "grok-4.5[effort=high,fast=true]"],
    ["cursor/composer-2.5", "composer-2.5[fast=true]"],
  ])("selects the unique advertised id for %s", (requested, expected) => {
    expect(resolveAdvertisedModelId(requested, availableModelIds)).toBe(expected);
  });

  it.each([
    // Two advertised variants: guessing would pick a model the caller did not choose.
    "gpt-5.5",
    // Not advertised, and not a bare prefix match for grok-4.5/grok-4.6.
    "grok-4",
    "anthropic/claude-haiku-4-5",
  ])("does not guess for %s", (requested) => {
    expect(resolveAdvertisedModelId(requested, availableModelIds)).toBeUndefined();
  });
});
