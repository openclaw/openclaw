import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
// Rcs tests cover the outbound presentation wiring exposed on the channel plugin:
// portable MessagePresentation is consumed and translated into a Twilio Content
// spec, or degrades to a plain text send.
import { describe, expect, it } from "vitest";
import { rcsPlugin } from "./channel.js";

function renderContent(presentation: MessagePresentation, text = "") {
  const rendered = rcsPlugin.outbound?.renderPresentation?.({
    payload: { text } as never,
    presentation,
    ctx: {} as never,
  });
  return (
    rendered as
      | { channelData?: { rcs?: { content?: { contentType?: string } } } }
      | null
      | undefined
  )?.channelData?.rcs?.content;
}

describe("rcsPlugin outbound presentation", () => {
  it("advertises button and select presentation support", () => {
    const caps = rcsPlugin.outbound?.presentationCapabilities;
    expect(caps?.supported).toBe(true);
    expect(caps?.buttons).toBe(true);
    expect(caps?.selects).toBe(true);
    expect(caps?.limits?.actions?.maxActions).toBe(11);
  });

  it("exposes a sendPayload path for rich content delivery", () => {
    expect(typeof rcsPlugin.outbound?.sendPayload).toBe("function");
  });

  it("renders suggested-reply presentation into an RCS card spec on channelData", () => {
    const content = renderContent(
      {
        blocks: [
          { type: "text", text: "Pick one" },
          {
            type: "buttons",
            buttons: [{ label: "Yes", action: { type: "callback", value: "yes" } }],
          },
        ],
      },
      "Pick one",
    );
    expect(content?.contentType).toBe("card");
  });

  it("renders a call-to-action card into a Twilio content spec", () => {
    const content = renderContent({
      title: "Update",
      blocks: [
        { type: "text", text: "Shipped" },
        {
          type: "buttons",
          buttons: [
            { label: "Track", action: { type: "url", url: "https://track.example" } },
            { label: "Reorder", action: { type: "callback", value: "reorder" } },
          ],
        },
      ],
    });
    expect(content?.contentType).toBe("card");
  });

  it("returns null so plain text presentation degrades to a normal text send", () => {
    const rendered = rcsPlugin.outbound?.renderPresentation?.({
      payload: { text: "hello" } as never,
      presentation: { blocks: [{ type: "text", text: "hello" }] },
      ctx: {} as never,
    });
    expect(rendered).toBeNull();
  });
});
