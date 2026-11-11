// Gateway Protocol tests cover channels.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ChannelsStatusResultSchema, WebLoginWaitParamsSchema } from "./schema/channels.js";

/**
 * Channel schema regressions for browser login and status diagnostics.
 * These payloads are consumed by dashboard/operator UI, so QR payload bounds
 * and event-loop diagnostic shape are part of the public gateway contract.
 */

describe("WebLoginWaitParamsSchema", () => {
  /** Compiled validator reused across QR bounds cases. */
  const validate = Compile(WebLoginWaitParamsSchema);

  it("bounds caller-provided QR data URLs", () => {
    expect(
      validate.Check({
        currentQrDataUrl: "data:image/png;base64,qr",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        currentQrDataUrl: "x".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      validate.Check({
        currentQrDataUrl: "https://example.com/qr.png",
      }),
    ).toBe(false);
  });
});

it("keeps channel sampling intervals integral while accepting fractional metrics", () => {
  const eventLoop = Compile(ChannelsStatusResultSchema.properties.eventLoop);
  for (const intervalMs of [0, 1, 0.5, -1]) {
    expect(
      eventLoop.Check({
        degraded: false,
        reasons: [],
        intervalMs,
        delayP99Ms: 1.25,
        delayMaxMs: 2.5,
        utilization: 0.2,
        cpuCoreRatio: 1.5,
      }),
      `intervalMs=${intervalMs}`,
    ).toBe(intervalMs === 0 || intervalMs === 1);
  }
});
