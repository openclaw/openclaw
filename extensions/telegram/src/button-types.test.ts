import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons, resolveTelegramInlineButtons } from "./button-types.js";

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

  it("drops buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Keep", value: "ok" },
              { label: "Drop", value: `x${"y".repeat(80)}` },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Keep", callback_data: "ok", style: undefined }]]);
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

  it("converts selects into inline buttons when button rendering is the supported fallback", () => {
    expect(
      buildTelegramInteractiveButtons(
        {
          blocks: [
            {
              type: "select",
              placeholder: "Pick one",
              options: [{ label: "Alpha", value: "alpha", actionId: "choice.alpha" }],
            },
          ],
        },
        {
          richReplies: {
            buttons: true,
            selects: false,
            commandFallback: true,
          },
        },
      ),
    ).toEqual([[{ text: "Alpha", callback_data: "alpha", style: undefined }]]);
  });
});
