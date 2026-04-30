import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons, resolveTelegramInlineButtons } from "./button-types.js";

export function describeTelegramInteractiveButtonBehavior(): void {
  describe("buildTelegramInteractiveButtons", () => {
    it("maps shared buttons and selects into Telegram inline rows", () => {
      expect(
        buildTelegramInteractiveButtons({
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve", style: "success" },
                { label: "Reject", value: "reject", style: "danger" },
                { label: "Later", value: "later" },
                { label: "Archive", value: "archive" },
              ],
            },
            {
              type: "select",
              options: [{ label: "Alpha", value: "alpha" }],
            },
          ],
        }),
      ).toEqual([
        [
          { text: "Approve", callback_data: "approve", style: "success" },
          { text: "Reject", callback_data: "reject", style: "danger" },
          { text: "Later", callback_data: "later", style: undefined },
        ],
        [{ text: "Archive", callback_data: "archive", style: undefined }],
        [{ text: "Alpha", callback_data: "alpha", style: undefined }],
      ]);
    });

    it("maps URL buttons to Telegram URL buttons by default", () => {
      expect(
        buildTelegramInteractiveButtons({
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", url: "https://example.com/app" }],
            },
          ],
        }),
      ).toEqual([[{ text: "Open", url: "https://example.com/app", style: undefined }]]);
    });

    it("maps HTTPS URL buttons to Mini App buttons when requested", () => {
      expect(
        buildTelegramInteractiveButtons(
          {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Open", url: "https://example.com/app" }],
              },
            ],
          },
          { urlButtonMode: "web_app" },
        ),
      ).toEqual([
        [{ text: "Open", web_app: { url: "https://example.com/app" }, style: undefined }],
      ]);
    });

    it("keeps non-HTTPS URL buttons as regular URL buttons for Mini App mode", () => {
      expect(
        buildTelegramInteractiveButtons(
          {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Open", url: "http://example.test/app" }],
              },
            ],
          },
          { urlButtonMode: "web_app" },
        ),
      ).toEqual([[{ text: "Open", url: "http://example.test/app", style: undefined }]]);
    });
  });

  describe("resolveTelegramInlineButtons", () => {
    it("prefers explicit buttons over shared interactive blocks", () => {
      const explicit = [[{ text: "Keep", callback_data: "keep" }]] as const;

      expect(
        resolveTelegramInlineButtons({
          buttons: explicit,
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Override", value: "override" }],
              },
            ],
          },
        }),
      ).toBe(explicit);
    });

    it("derives buttons from raw interactive payloads", () => {
      expect(
        resolveTelegramInlineButtons({
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Retry", value: "retry", style: "primary" }],
              },
            ],
          },
        }),
      ).toEqual([[{ text: "Retry", callback_data: "retry", style: "primary" }]]);
    });
  });
}
