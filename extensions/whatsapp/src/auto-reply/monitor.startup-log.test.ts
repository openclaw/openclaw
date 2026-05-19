import { describe, expect, it } from "vitest";
import { formatInboundListenerLog } from "./monitor.js";

describe("formatInboundListenerLog", () => {
  it("reports DM-only when no groups are configured", () => {
    expect(formatInboundListenerLog(undefined)).toBe(
      "Listening for WhatsApp inbound messages (DM only).",
    );
    expect(formatInboundListenerLog({})).toBe("Listening for WhatsApp inbound messages (DM only).");
  });

  it("reports the configured group count with singular noun for one group", () => {
    expect(formatInboundListenerLog({ "a@g.us": {} })).toBe(
      "Listening for WhatsApp inbound messages (DM + 1 group).",
    );
  });

  it("uses plural noun for multiple configured groups", () => {
    expect(formatInboundListenerLog({ "a@g.us": {}, "b@g.us": {}, "c@g.us": {} })).toBe(
      "Listening for WhatsApp inbound messages (DM + 3 groups).",
    );
  });

  it("treats the wildcard entry as all groups regardless of other entries", () => {
    expect(formatInboundListenerLog({ "*": {} })).toBe(
      "Listening for WhatsApp inbound messages (DM + all groups).",
    );
    expect(formatInboundListenerLog({ "*": {}, "a@g.us": {} })).toBe(
      "Listening for WhatsApp inbound messages (DM + all groups).",
    );
  });
});
