import { describe, expect, it } from "vitest";
import { resolveClawWRTConfig } from "./config.js";

describe("resolveClawWRTConfig", () => {
  it("enables bridge by default", () => {
    expect(resolveClawWRTConfig(undefined).enabled).toBe(true);
    expect(resolveClawWRTConfig({}).enabled).toBe(true);
  });

  it("allows explicit disable", () => {
    expect(resolveClawWRTConfig({ enabled: false }).enabled).toBe(false);
  });

  it("preserves valid fields when another field is invalid", () => {
    const resolved = resolveClawWRTConfig({
      enabled: false,
      requestTimeoutMs: 10_000.5,
      bind: "0.0.0.0",
    });

    expect(resolved.enabled).toBe(false);
    expect(resolved.bind).toBe("0.0.0.0");
    expect(resolved.requestTimeoutMs).toBe(10_000);
  });

  it("falls back only the invalid integer field instead of resetting the whole config", () => {
    const resolved = resolveClawWRTConfig({
      port: 8001.5,
      awasPort: 81.2,
      allowDeviceIds: ["dev-b", "dev-a"],
    });

    expect(resolved.port).toBe(8001);
    expect(resolved.awas.port).toBe(80);
    expect(resolved.allowDeviceIds).toEqual(["dev-a", "dev-b"]);
  });
});
