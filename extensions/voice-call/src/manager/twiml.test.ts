import { describe, expect, it } from "vitest";
import { generateDtmfRedirectTwiml, generateNotifyTwiml } from "./twiml.js";

describe("generateNotifyTwiml", () => {
  it("renders escaped xml with the requested voice", () => {
    expect(generateNotifyTwiml(`Call <ended> & "logged"`, "Polly.Joanna"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Call &lt;ended&gt; &amp; &quot;logged&quot;</Say>
  <Hangup/>
</Response>`);
  });

  it("renders escaped DTMF redirects", () => {
    expect(generateDtmfRedirectTwiml(`12<&"`, "https://example.test/hook?x=<y>&z=1"))
      .toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="12&lt;&amp;&quot;" />
  <Redirect method="POST">https://example.test/hook?x=&lt;y&gt;&amp;z=1</Redirect>
</Response>`);
  });
});
