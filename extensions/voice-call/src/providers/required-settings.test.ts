import { describe, expect, it } from "vitest";
import { PlivoProvider } from "./plivo.js";
import { TelnyxProvider } from "./telnyx.js";
import { TwilioProvider } from "./twilio.js";

describe("carrier provider required settings", () => {
  it.each([
    [() => new PlivoProvider({ authId: "" }), "Plivo Auth ID is required"],
    [() => new PlivoProvider({ authId: "fixture-id" }), "Plivo Auth Token is required"],
    [() => new TelnyxProvider({ apiKey: "" }), "Telnyx API key is required"],
    [() => new TelnyxProvider({ apiKey: "fixture-key" }), "Telnyx connection ID is required"],
    [() => new TwilioProvider({ accountSid: "" }), "Twilio Account SID is required"],
    [() => new TwilioProvider({ accountSid: "fixture-sid" }), "Twilio Auth Token is required"],
  ] as const)("rejects incomplete settings: %s", (construct, message) => {
    expect(construct).toThrow(message);
  });
});
