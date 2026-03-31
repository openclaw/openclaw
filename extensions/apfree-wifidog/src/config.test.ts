import { describe, expect, it } from "vitest";
import { resolveApFreeWifidogConfig } from "./config.js";

describe("resolveApFreeWifidogConfig", () => {
  it("enables bridge by default", () => {
    expect(resolveApFreeWifidogConfig(undefined).enabled).toBe(true);
    expect(resolveApFreeWifidogConfig({}).enabled).toBe(true);
  });

  it("allows explicit disable", () => {
    expect(resolveApFreeWifidogConfig({ enabled: false }).enabled).toBe(false);
  });

  it("preserves valid fields when another field is invalid", () => {
    const resolved = resolveApFreeWifidogConfig({
      enabled: false,
      requestTimeoutMs: 10_000.5,
      bind: "0.0.0.0",
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.bind).toBe("0.0.0.0");
    expect(resolved.requestTimeoutMs).toBe(10_000);
  });

  it("falls back only the invalid integer field instead of resetting the whole config", () => {
    const resolved = resolveApFreeWifidogConfig({
      port: 8001.5,
      awasPort: 81.2,
      allowDeviceIds: ["dev-b", "dev-a"],
    });

    expect(resolved.port).toBe(8001);
    expect(resolved.awas.port).toBe(80);
    expect(resolved.allowDeviceIds).toEqual(["dev-a", "dev-b"]);
  });
});
