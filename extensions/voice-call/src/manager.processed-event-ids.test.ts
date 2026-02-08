import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";

/** Helper to access private members in tests. */
function internals(mgr: CallManager) {
  return mgr as unknown as {
    processedEventIds: Set<string>;
    maxProcessedEventIds: number;
    rememberProcessedEventId: (id: string) => void;
  };
}

describe("CallManager processedEventIds bounded set", () => {
  it("evicts the oldest ID when the cap is exceeded", () => {
    const cfg = VoiceCallConfigSchema.parse({});
    const mgr = new CallManager(cfg);
    const priv = internals(mgr);
    priv.maxProcessedEventIds = 3;

    priv.rememberProcessedEventId("e1");
    priv.rememberProcessedEventId("e2");
    priv.rememberProcessedEventId("e3");
    expect(priv.processedEventIds.size).toBe(3);

    // Adding a 4th should evict the oldest (e1)
    priv.rememberProcessedEventId("e4");
    expect(priv.processedEventIds.size).toBe(3);
    expect(priv.processedEventIds.has("e1")).toBe(false);
    expect(priv.processedEventIds.has("e4")).toBe(true);
  });

  it("does not evict when under the cap", () => {
    const cfg = VoiceCallConfigSchema.parse({});
    const mgr = new CallManager(cfg);
    const priv = internals(mgr);
    priv.maxProcessedEventIds = 100;

    for (let i = 0; i < 50; i++) {
      priv.rememberProcessedEventId(`ev-${i}`);
    }
    expect(priv.processedEventIds.size).toBe(50);
    expect(priv.processedEventIds.has("ev-0")).toBe(true);
  });

  it("handles duplicate IDs without growing", () => {
    const cfg = VoiceCallConfigSchema.parse({});
    const mgr = new CallManager(cfg);
    const priv = internals(mgr);
    priv.maxProcessedEventIds = 3;

    priv.rememberProcessedEventId("e1");
    priv.rememberProcessedEventId("e1");
    priv.rememberProcessedEventId("e1");
    expect(priv.processedEventIds.size).toBe(1);
  });
});
