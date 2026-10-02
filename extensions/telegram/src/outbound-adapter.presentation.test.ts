// Telegram presentation rendering tests for the outbound adapter.
import { adaptMessagePresentationForChannel } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound presentation", () => {
  it("preserves fallback labels after core capability adaptation", async () => {
    const label = "Open the workspace with the complete deployment instructions for production";
    const sourcePresentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Continue", action: { type: "command" as const, command: "/continue" } },
            { label, action: { type: "web-app" as const, url: "https://example.com/app" } },
          ],
        },
      ],
    };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { presentationTextMode: "fallback" },
      presentation: adaptMessagePresentationForChannel({
        presentation: sourcePresentation,
        capabilities: telegramOutbound.presentationCapabilities,
      }),
      sourcePresentation,
      ctx: { cfg: {}, to: "-10012345" } as never,
    });

    expect(rendered?.text).toContain(label);
    expect(rendered?.text).toContain("https://example.com/app");
    expect(rendered?.channelData?.telegram).toEqual({
      buttons: [[{ text: "Continue", callback_data: "tgcmd:/continue" }]],
    });
  });

  it("preserves explicit Telegram buttons when rendering presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Use native buttons:",
        channelData: {
          telegram: {
            buttons: [[{ text: "Native", callback_data: "native" }]],
          },
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });

    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Native", callback_data: "native" }]],
    });
    expect(rendered?.text).toBe("Use native buttons:\n\n- Generic");
  });

  it("preserves legacy interactive buttons when rendering mixed presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Choose:",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });
    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Legacy", callback_data: "legacy" }]],
    });

    expect(rendered?.text).toBe("Choose:\n\n- Generic");
  });
});
