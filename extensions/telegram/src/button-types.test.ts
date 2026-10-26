import type { MessagePresentationButton } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { parseTelegramApprovalCallbackData } from "./approval-callback-data.js";
import { buildTelegramPresentationButtons, resolveTelegramInlineButtons } from "./button-types.js";
import {
  parseTelegramNativeCommandCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { parseTelegramQuestionCallbackData } from "./question-callback-data.js";

function buildButtons(buttons: MessagePresentationButton[]) {
  return buildTelegramPresentationButtons({ blocks: [{ type: "buttons", buttons }] });
}
const callbacks = (buttons: MessagePresentationButton[]) =>
  buildButtons(buttons)
    ?.flat()
    .map((button) => button.callback_data);
const actionButton = (action: NonNullable<MessagePresentationButton["action"]>) => ({
  label: "Action",
  action,
});
const approval = (approvalId: string, decision: "allow-once" | "allow-always") =>
  ({ type: "approval", approvalId, approvalKind: "exec", decision }) as const;

describe("resolveTelegramInlineButtons precedence", () => {
  it("falls back to presentation when legacy content has no controls", () => {
    expect(
      resolveTelegramInlineButtons({
        interactive: { blocks: [{ type: "text", text: "Legacy heading" }] },
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Fallback", value: "fallback" }] }],
        },
      })?.[0]?.[0]?.callback_data,
    ).toBe("fallback");
  });
});

describe("buildTelegramPresentationButtons action domains", () => {
  it("keeps raw slash callbacks distinct from typed commands and drops oversized commands", () => {
    expect(
      callbacks([
        { label: "Raw", value: "/approve req-1 allow-once" },
        actionButton({ type: "command", command: "/approve req-1 allow-once" }),
        actionButton({ type: "command", command: `/codex plugins enable ${"x".repeat(80)}` }),
      ]),
    ).toEqual(["/approve req-1 allow-once", "tgcmd:/approve req-1 allow-once"]);
  });

  it.each([true, false])(
    "keeps callback identity outside native namespaces (typed=%s)",
    (typed) => {
      const values = typed
        ? [" /approve env|prod allow-once "]
        : [" tga1:e:x:plugin|123 ", " tgq1:ask_0123456789abcdef0123456789abcdef:0 "];
      const data = callbacks(
        values.map((value) =>
          typed ? actionButton({ type: "callback", value }) : { label: "Plugin", value },
        ),
      );
      expect(data?.map(parseTelegramOpaqueCallbackData)).toEqual(values);
      for (const callback of data ?? []) {
        expect(parseTelegramApprovalCallbackData(callback)).toBeNull();
        expect(parseTelegramNativeCommandCallbackData(callback)).toBeNull();
        expect(parseTelegramQuestionCallbackData(callback)).toBeNull();
      }
    },
  );

  it("keeps legacy values that look like opaque callback prefixes raw", () => {
    const rows = buildButtons([{ label: "Raw", value: "tgcb1:inspect:123" }]);
    expect(rows?.[0]?.[0]?.callback_data).toBe("tgcb1:inspect:123");
    expect(parseTelegramOpaqueCallbackData(rows?.[0]?.[0]?.callback_data)).toBeNull();
  });

  it("encodes typed approvals with exact identity beside a Review URL", () => {
    const rows = buildButtons([
      actionButton(approval("plugin:id/with:delimiters", "allow-always")),
      { label: "Review", action: { type: "url", url: "https://gateway.example/approve/long-id" } },
    ]);
    expect(parseTelegramApprovalCallbackData(rows?.[0]?.[0]?.callback_data)).toEqual(
      approval("plugin:id/with:delimiters", "allow-always"),
    );
    expect(rows?.[0]?.[1]?.url).toBe("https://gateway.example/approve/long-id");
  });

  it("keeps question option indices independent and stable across presentation blocks", () => {
    const firstQuestionId = `ask_${"a".repeat(32)}`;
    const secondQuestionId = `ask_${"b".repeat(32)}`;
    const questionBlock = (questionId: string, values: string[]) => ({
      type: "buttons" as const,
      buttons: values.map((optionValue) => ({
        label: optionValue,
        action: { type: "question" as const, questionId, optionValue },
      })),
    });
    const indices = (values: string[]) => new Map(values.map((value, index) => [value, index]));
    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          questionBlock(firstQuestionId, ["東京", "Déployer"]),
          questionBlock(secondQuestionId, ["東京", "Production"]),
          questionBlock(firstQuestionId, ["東京", "Production 🚀"]),
        ],
      },
      {
        questionOptionIndices: new Map([
          [firstQuestionId, indices(["東京", "déployer", "production 🚀"])],
          [secondQuestionId, indices(["東京", "production"])],
        ]),
      },
    );
    expect(
      rows?.flat().map((button) => parseTelegramQuestionCallbackData(button.callback_data)),
    ).toEqual([
      { questionId: firstQuestionId, intent: "select", optionIndex: 0 },
      { questionId: firstQuestionId, intent: "select", optionIndex: 1 },
      { questionId: secondQuestionId, intent: "select", optionIndex: 0 },
      { questionId: secondQuestionId, intent: "select", optionIndex: 1 },
      { questionId: firstQuestionId, intent: "select", optionIndex: 0 },
      { questionId: firstQuestionId, intent: "select", optionIndex: 2 },
    ]);
  });
});
