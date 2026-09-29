// Voice Call tests cover Twilio speech gather TwiML helpers.
import { describe, expect, it } from "vitest";
import {
  TWILIO_SPEECH_GATHER_TIMEOUT_SEC,
  buildTwilioSpeechGatherVerbs,
} from "./speech-gather.js";

describe("buildTwilioSpeechGatherVerbs", () => {
  it("includes a long gather timeout and redirect to keep the call alive", () => {
    const xml = buildTwilioSpeechGatherVerbs({
      webhookUrl: "https://example.ngrok.app/voice/twilio?callId=call-1",
    });

    expect(xml).toContain(`timeout="${TWILIO_SPEECH_GATHER_TIMEOUT_SEC}"`);
    expect(xml).toContain('speechTimeout="auto"');
    expect(xml).toContain(
      'action="https://example.ngrok.app/voice/twilio?callId=call-1"',
    );
    expect(xml).toContain(
      '<Redirect method="POST">https://example.ngrok.app/voice/twilio?callId=call-1</Redirect>',
    );
  });

  it("adds turnToken to the gather action URL", () => {
    const xml = buildTwilioSpeechGatherVerbs({
      webhookUrl: "https://example.ngrok.app/voice/twilio?callId=call-1",
      turnToken: "turn-xyz",
    });

    expect(xml).toContain("turnToken=turn-xyz");
  });
});
