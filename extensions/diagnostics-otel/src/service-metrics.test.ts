import type { Meter } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsMetrics } from "./service-metrics.js";

describe("diagnostics metric attributes", () => {
  it("applies the metric-specific retained attribute list", () => {
    const add = vi.fn();
    const record = vi.fn();
    const meter = {
      createCounter: () => ({ add }),
      createHistogram: () => ({ record }),
    } as unknown as Meter;
    const metrics = createDiagnosticsMetrics(meter, undefined, ["openclaw.sessionId"]);

    metrics.tokensCounter.add(1, {
      "openclaw.sessionId": "retained",
      "openclaw.runId": "filtered",
      "openclaw.provider": "anthropic",
    });

    expect(add).toHaveBeenCalledWith(1, {
      "openclaw.sessionId": "retained",
      "openclaw.provider": "anthropic",
    });
  });
});
