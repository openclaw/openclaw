import { afterEach, describe, expect, it } from "vitest";
import { isClaworksProductionMode } from "./product-env.js";

describe("isClaworksProductionMode", () => {
  const prev = process.env.CLAWORKS_PRODUCTION;

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.CLAWORKS_PRODUCTION;
    } else {
      process.env.CLAWORKS_PRODUCTION = prev;
    }
  });

  it("returns true when config.production_mode is true", () => {
    expect(isClaworksProductionMode({ production_mode: true }, {})).toBe(true);
  });

  it("returns false when config.production_mode is false even if env is set", () => {
    expect(isClaworksProductionMode({ production_mode: false }, { CLAWORKS_PRODUCTION: "1" })).toBe(
      false,
    );
  });

  it("falls back to CLAWORKS_PRODUCTION=1 when config unset", () => {
    expect(isClaworksProductionMode({}, { CLAWORKS_PRODUCTION: "1" })).toBe(true);
    expect(isClaworksProductionMode({}, { CLAWORKS_PRODUCTION: "0" })).toBe(false);
  });
});
