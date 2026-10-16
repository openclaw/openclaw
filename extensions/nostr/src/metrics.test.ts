import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createMetrics, type MetricEvent } from "./metrics.js";
import { TEST_RELAY_URL } from "./test-fixtures.js";

function createCollectingMetrics() {
  const events: MetricEvent[] = [];
  return {
    events,
    metrics: createMetrics((event) => events.push(event)),
  };
}

describe("Metrics", () => {
  describe("createMetrics", () => {
    it("emits metric events to callback", () => {
      const { events, metrics } = createCollectingMetrics();

      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("event.duplicate");

      expect(events).toHaveLength(3);
      expect(expectDefined(events[0], "first Nostr metric event").name).toBe("event.received");
      expect(expectDefined(events[1], "second Nostr metric event").name).toBe("event.processed");
      expect(expectDefined(events[2], "third Nostr metric event").name).toBe("event.duplicate");
    });

    it("includes labels in metric events", () => {
      const { events, metrics } = createCollectingMetrics();

      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL });

      expect(expectDefined(events[0], "first Nostr metric event").labels).toEqual({
        relay: TEST_RELAY_URL,
      });
    });
  });
});
