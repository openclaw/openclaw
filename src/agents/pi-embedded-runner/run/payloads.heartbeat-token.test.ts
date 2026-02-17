import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads heartbeat token handling", () => {
  it("drops pure HEARTBEAT_OK payloads", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["HEARTBEAT_OK"],
      toolMetas: [],
      lastAssistant: undefined,
      sessionKey: "agent:main:main",
      inlineToolResultsAllowed: false,
    });

    expect(payloads).toEqual([]);
  });

  it("strips leading heartbeat token and keeps real message content", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["HEARTBEAT_OK all clear"],
      toolMetas: [],
      lastAssistant: undefined,
      sessionKey: "agent:main:main",
      inlineToolResultsAllowed: false,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("all clear");
  });

  it("keeps media payloads even when text is only HEARTBEAT_OK", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["HEARTBEAT_OK\nMEDIA:https://example.com/image.png"],
      toolMetas: [],
      lastAssistant: undefined,
      sessionKey: "agent:main:main",
      inlineToolResultsAllowed: false,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("");
    expect(payloads[0]?.mediaUrl).toBe("https://example.com/image.png");
  });
});
