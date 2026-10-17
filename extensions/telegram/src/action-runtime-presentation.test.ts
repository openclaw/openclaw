import { describe, expect, it } from "vitest";
import {
  appendTelegramActionDroppedControlFallback,
  hydrateTelegramDroppedControlFallbacks,
  readTelegramSendContent,
  renderTelegramActionPresentationText,
  type TelegramActionDroppedControl,
} from "./action-runtime-presentation.js";

const copyPresentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [
        {
          label: "Copy token",
          action: { type: "copy-text" as const, text: "TOKEN\r7319" },
        },
      ],
    },
  ],
};

describe("Telegram direct-action presentation handling", () => {
  it("uses a neutral body anchor without exposing a native copy value", () => {
    expect(
      readTelegramSendContent({
        args: {},
        hasButtons: true,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({ content: "Choose an option.", hasExplicitContent: false });
  });

  it("retains visible presentation text while excluding control values", () => {
    const presentation = {
      title: "Updated status",
      blocks: [{ type: "text" as const, text: "Build completed" }, ...copyPresentation.blocks],
    };

    expect(renderTelegramActionPresentationText(presentation)).toBe(
      "Updated status\n\nBuild completed",
    );
    expect(readTelegramSendContent({ args: {}, hasButtons: true, presentation }).content).toBe(
      "Updated status\n\nBuild completed",
    );
  });

  it("retains a select prompt without exposing option values", () => {
    expect(
      readTelegramSendContent({
        args: {},
        hasButtons: true,
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Choose deployment environment",
              options: [
                { label: "Staging", value: "staging" },
                { label: "Production", value: "production" },
              ],
            },
          ],
        },
      }),
    ).toEqual({ content: "Choose deployment environment", hasExplicitContent: false });
  });

  it("does not synthesize a text anchor for standalone locations", () => {
    expect(
      readTelegramSendContent({
        args: { content: "" },
        hasButtons: true,
        hasLocation: true,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Continue", action: { type: "callback", value: "continue" } }],
            },
          ],
        },
      }),
    ).toEqual({ content: "", hasExplicitContent: true });
  });

  it("hydrates rejected copy controls with escaped exact-value fallback", () => {
    const dropped: TelegramActionDroppedControl[] = [
      {
        actionType: "copy-text",
        copyTextFallback: "TOKEN\\r7319",
        label: "Copy token",
        reason: "copy_text_invalid",
      },
    ];

    hydrateTelegramDroppedControlFallbacks(dropped, copyPresentation);

    expect(dropped).toEqual([
      {
        actionType: "copy-text",
        copyTextFallback: "TOKEN\\r7319",
        label: "Copy token",
        reason: "copy_text_invalid",
        fallbackText: "TOKEN\\r7319",
      },
    ]);
    expect(appendTelegramActionDroppedControlFallback("Updated body", dropped)).toBe(
      "Updated body\n\n- Copy token: `TOKEN\\r7319`",
    );
  });

  it("uses drop-time copy identity when a native control has the same label", () => {
    const dropped: TelegramActionDroppedControl[] = [
      {
        actionType: "copy-text",
        copyTextFallback: "REJECTED\\rVALUE",
        label: "Copy",
        reason: "copy_text_invalid",
      },
    ];
    hydrateTelegramDroppedControlFallbacks(dropped, {
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Copy", action: { type: "copy-text", text: "NATIVE" } },
            { label: "Copy", action: { type: "copy-text", text: "REJECTED\rVALUE" } },
          ],
        },
      ],
    });

    expect(dropped[0]?.fallbackText).toBe("REJECTED\\rVALUE");
  });

  it("matches duplicate labels only to dropped copy actions in authored order", () => {
    const dropped: TelegramActionDroppedControl[] = [
      {
        actionType: "callback",
        label: "Copy",
        reason: "presentation_action_budget_exceeded",
      },
      {
        actionType: "copy-text",
        label: "Copy",
        reason: "presentation_action_budget_exceeded",
      },
      { actionType: "copy-text", label: "Copy", reason: "presentation_keyboard_precedence" },
    ];
    hydrateTelegramDroppedControlFallbacks(dropped, {
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Copy", action: { type: "copy-text", text: "first" } },
            { label: "Copy", action: { type: "copy-text", text: "second" } },
          ],
        },
      ],
    });

    expect(dropped.map((control) => control.fallbackText)).toEqual([undefined, "first", "second"]);
  });
});
