// Voice Call tests cover voice mapping plugin behavior.
import { describe, expect, it } from "vitest";
import { escapeXml, mapVoiceToPolly } from "./voice-mapping.js";

describe("voice mapping", () => {
  it("escapes xml-special characters", () => {
    expect(escapeXml(`5 < 6 & "quote" 'apostrophe' > 4`)).toBe(
      "5 &lt; 6 &amp; &quot;quote&quot; &apos;apostrophe&apos; &gt; 4",
    );
  });

  it.each([
    { voice: "alloy", expected: "Polly.Joanna" },
    { voice: "echo", expected: "Polly.Matthew" },
    { voice: "fable", expected: "Polly.Amy" },
    { voice: "onyx", expected: "Polly.Brian" },
    { voice: "nova", expected: "Polly.Salli" },
    { voice: "shimmer", expected: "Polly.Kimberly" },
    { voice: "ECHO", expected: "Polly.Matthew" },
    { voice: "Polly.Brian", expected: "Polly.Brian" },
    { voice: "Google.en-US-Standard-C", expected: "Google.en-US-Standard-C" },
    { voice: "unknown", expected: "Polly.Joanna" },
    { voice: "UnKnOwN", expected: "Polly.Joanna" },
    { voice: "toString", expected: "Polly.Joanna" },
    { voice: "", expected: "Polly.Joanna" },
    { voice: "   ", expected: "Polly.Joanna" },
    { voice: undefined, expected: "Polly.Joanna" },
  ])("maps $voice to $expected", ({ voice, expected }) => {
    expect(mapVoiceToPolly(voice)).toBe(expected);
  });

  it.each(["constructor", "__proto__"])(
    "falls back to the default Polly voice for prototype key %s",
    (voice) => {
      expect(mapVoiceToPolly(voice)).toBe("Polly.Joanna");
    },
  );
});
