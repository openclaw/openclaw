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
  it("returns explicit buttons without reading lower-priority payloads", () => {
    const buttons = [[{ text: "Explicit", callback_data: "explicit" }]];
    expect(
      resolveTelegramInlineButtons({
        buttons,
        get interactive(): never {
          throw new Error("unexpected interactive normalization");
        },
        get presentation(): never {
          throw new Error("unexpected presentation normalization");
        },
      }),
    ).toBe(buttons);
  });

  it.each([{ blocks: [{ type: "text", text: "Legacy heading" }] }])(
    "falls back to presentation when the legacy payload has no usable controls: %j",
    (interactive) => {
      expect(
        resolveTelegramInlineButtons({
          interactive,
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Fallback", value: "fallback" }] }],
          },
        })
          ?.flat()
          .map((button) => button.callback_data),
      ).toEqual(["fallback"]);
    },
  );
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

  it("keeps typed callback values opaque, including slash text, whitespace and delimiters", () => {
    const values = ["/not-a-native-command", "env | prod", "/approve plugin:123 allow-once"];
    const data = callbacks(values.map((value) => actionButton({ type: "callback", value })));
    expect(data?.map(parseTelegramOpaqueCallbackData)).toEqual(values);
    for (const callback of data ?? []) {
      expect(parseTelegramApprovalCallbackData(callback)).toBeNull();
      expect(parseTelegramNativeCommandCallbackData(callback)).toBeNull();
    }
  });

  it("reserves approval and question namespaces without trimming legacy callback identity", () => {
    const values = [
      "tga1:e:x:not-a-typed-action",
      " tga1:e:o:plugin:123 ",
      "tgq1:ask_0123456789abcdef0123456789abcdef:0",
      " tgq1:ask_0123456789abcdef0123456789abcdef:0 ",
    ];
    const data = callbacks(values.map((value) => ({ label: "Plugin", value })));
    expect(data?.map(parseTelegramOpaqueCallbackData)).toEqual(values);
    for (const callback of data ?? []) {
      expect(parseTelegramApprovalCallbackData(callback)).toBeNull();
      expect(parseTelegramQuestionCallbackData(callback)).toBeNull();
    }
  });

  it("keeps legacy values that look like opaque callback prefixes raw", () => {
    const rows = buildButtons([{ label: "Raw", value: "tgcb1:inspect:123" }]);
    expect(rows?.[0]?.[0]?.callback_data).toBe("tgcb1:inspect:123");
    expect(parseTelegramOpaqueCallbackData(rows?.[0]?.[0]?.callback_data)).toBeNull();
  });

  it("shortens legacy allow-always before prefixing and retains the approval overflow path", () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const approvalId = `plugin:${"a".repeat(36)}`;
    const data = callbacks(
      [uuid, approvalId].map((id) => ({
        label: "Always",
        action: { type: "command", command: `/approve ${id} allow-always` },
      })),
    );
    expect(data).toEqual([`tgcmd:/approve ${uuid} always`, `/approve ${approvalId} always`]);
  });

  it("encodes typed approvals with explicit kind, decision, and exact id", () => {
    const data = callbacks([actionButton(approval("plugin:id/with:delimiters", "allow-always"))]);
    expect(parseTelegramApprovalCallbackData(data?.[0])).toEqual(
      approval("plugin:id/with:delimiters", "allow-always"),
    );
  });

  it("compacts an overlong approval callback and keeps the Review URL", () => {
    const rows = buildButtons([
      actionButton(approval("x".repeat(56), "allow-once")),
      { label: "Review", action: { type: "url", url: "https://gateway.example/approve/long-id" } },
    ]);
    expect(parseTelegramApprovalCallbackData(rows?.[0]?.[0]?.callback_data)).toEqual({
      type: "approval",
      approvalId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(rows?.[0]?.[1]?.url).toBe("https://gateway.example/approve/long-id");
  });

  it("keeps question option indices independent and stable across presentation blocks", () => {
    const firstQuestionId = "ask_0123456789abcdef0123456789abcdef";
    const secondQuestionId = "ask_fedcba9876543210fedcba9876543210";
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
