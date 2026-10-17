import { describe, expect, it } from "vitest";
import {
  buildTelegramPresentationButtons,
  escapeTelegramCopyTextFallback,
  isValidTelegramCopyText,
  resolveTelegramButtonsFromParams,
  type TelegramDroppedControl,
} from "./button-types.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";

function copyPresentation(text: string) {
  return {
    blocks: [
      {
        type: "buttons" as const,
        buttons: [{ label: "Copy token", action: { type: "copy-text" as const, text } }],
      },
    ],
  };
}

describe("Telegram copy-text controls", () => {
  it("maps exact TDLib-safe values to native copy_text buttons", () => {
    const text = `${"x".repeat(255)}😀`;
    expect(isValidTelegramCopyText(text)).toBe(true);
    const rows = buildTelegramPresentationButtons(copyPresentation(text));
    expect(rows).toEqual([[{ text: "Copy token", copy_text: { text } }]]);
    expect(buildInlineKeyboard(rows)).toEqual({
      inline_keyboard: [[{ text: "Copy token", copy_text: { text } }]],
    });
  });

  it.each([
    ["257 scalars", "x".repeat(257)],
    ["carriage return", "TOKEN\r7319"],
    ["tab", "TOKEN\t7319"],
    ["lone surrogate", "TOKEN\ud8007319"],
  ])("rejects %s and records a readable fallback reason", (_name, text) => {
    const dropped: TelegramDroppedControl[] = [];
    expect(
      buildTelegramPresentationButtons(copyPresentation(text), {
        onDroppedControl: (control) => dropped.push(control),
      }),
    ).toBeUndefined();
    expect(dropped).toEqual([
      {
        actionType: "copy-text",
        copyTextFallback: escapeTelegramCopyTextFallback(text),
        label: "Copy token",
        reason: "copy_text_invalid",
      },
    ]);
    expect(escapeTelegramCopyTextFallback(text)).not.toContain("\r");
  });

  it("spends the shared 100-action budget and records copy overflow", () => {
    const dropped: TelegramDroppedControl[] = [];
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            ...Array.from({ length: 100 }, (_, index) => ({
              label: `Action ${String(index)}`,
              value: `action:${String(index)}`,
            })),
            {
              label: "Copy token",
              action: { type: "copy-text" as const, text: "TOKEN-7319" },
            },
          ],
        },
      ],
    };

    expect(
      buildTelegramPresentationButtons(presentation, { onDroppedControl: (c) => dropped.push(c) }),
    ).toHaveLength(34);
    expect(dropped).toEqual([
      {
        actionType: "copy-text",
        copyTextFallback: "TOKEN-7319",
        label: "Copy token",
        reason: "presentation_action_budget_exceeded",
      },
    ]);
  });

  it("routes copy to readable fallback when a 100-option select fills the keyboard", () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      label: `Option ${String(index + 1)}`,
      value: `option:${String(index + 1)}`,
    }));
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Target", options },
          ...copyPresentation("TOKEN-7319").blocks,
        ],
      },
    });

    const rows = (result.channelData?.telegram as { buttons?: unknown[][] } | undefined)?.buttons;
    expect(rows?.flat()).toHaveLength(100);
    expect(rows?.flat().map((button) => (button as { text: string }).text)).toEqual(
      options.map((option) => option.label),
    );
    expect(result.text).toContain("- Copy token: `TOKEN-7319`");
  });

  it("uses the final keyboard slot for copy after a 99-option select", () => {
    const options = Array.from({ length: 99 }, (_, index) => ({
      label: `Option ${String(index + 1)}`,
      value: `option:${String(index + 1)}`,
    }));
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Target", options },
          ...copyPresentation("TOKEN-7319").blocks,
        ],
      },
    });

    const rows = (result.channelData?.telegram as { buttons?: unknown[][] } | undefined)?.buttons;
    expect(rows?.flat()).toHaveLength(100);
    expect(rows?.flat().at(-1)).toEqual({
      text: "Copy token",
      copy_text: { text: "TOKEN-7319" },
    });
    expect(result.text).not.toContain("TOKEN-7319");
  });

  it("keeps mixed control order and degrades copy when only one post-select slot remains", () => {
    const options = Array.from({ length: 99 }, (_, index) => ({
      label: `Option ${String(index + 1)}`,
      value: `option:${String(index + 1)}`,
    }));
    const result = canonicalizeTelegramPresentationPayload({
      presentation: {
        blocks: [
          { type: "select", placeholder: "Target", options },
          {
            type: "buttons",
            buttons: [
              { label: "Continue", value: "continue" },
              {
                label: "Copy token",
                action: { type: "copy-text", text: "TOKEN-7319" },
              },
            ],
          },
        ],
      },
    });

    const rows = (result.channelData?.telegram as { buttons?: unknown[][] } | undefined)?.buttons;
    expect(rows?.flat()).toHaveLength(100);
    expect(rows?.flat().at(-1)).toEqual({ text: "Continue", callback_data: "continue" });
    expect(result.text).toContain("- Copy token: `TOKEN-7319`");
  });

  it("uses a body anchor for native copy and readable fallback for invalid copy", () => {
    const native = canonicalizeTelegramPresentationPayload({
      presentation: copyPresentation("TOKEN-7319"),
    });
    expect(native.text).toBe("Choose an option.");
    expect(native.text).not.toContain("TOKEN-7319");
    expect(native.channelData?.telegram).toEqual({
      buttons: [[{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }]],
    });

    const invalid = canonicalizeTelegramPresentationPayload({
      presentation: copyPresentation("TOKEN\r7319"),
    });
    expect(invalid.text).toBe("- Copy token: `TOKEN\\r7319`");
    expect(invalid.channelData?.telegram).toBeUndefined();
  });

  it("renders portable copy controls when a legacy keyboard owns Telegram markup", () => {
    const result = canonicalizeTelegramPresentationPayload({
      interactive: {
        blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
      },
      presentation: copyPresentation("TOKEN-7319"),
    });

    expect(result.text).toBe("- Copy token: `TOKEN-7319`");
    expect(result.channelData?.telegram).toEqual({
      buttons: [[{ text: "Legacy", callback_data: "legacy" }]],
    });
  });

  it("does not report presentation precedence when legacy controls are unusable", () => {
    const dropped: TelegramDroppedControl[] = [];
    expect(
      resolveTelegramButtonsFromParams(
        {
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "Oversized", value: "x".repeat(65) }] }],
          },
          presentation: copyPresentation("TOKEN-7319"),
        },
        undefined,
        { onDroppedControl: (control) => dropped.push(control) },
      ),
    ).toEqual([[{ text: "Copy token", copy_text: { text: "TOKEN-7319" } }]]);
    expect(dropped).toEqual([
      {
        actionType: "callback",
        callbackDataBytes: 65,
        label: "Oversized",
        reason: "callback_data_too_long",
      },
    ]);
  });
});
