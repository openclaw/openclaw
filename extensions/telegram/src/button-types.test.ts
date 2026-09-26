import { describe, expect, it } from "vitest";
import { parseTelegramApprovalCallbackData } from "./approval-callback-data.js";
import { buildTelegramPresentationButtons, resolveTelegramInlineButtons } from "./button-types.js";
import {
  parseTelegramNativeCommandCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { parseTelegramQuestionCallbackData } from "./question-callback-data.js";

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

  it("prefers legacy approval aliases over generic presentation buttons", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    const rows = resolveTelegramInlineButtons({
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Allow Always", value: `/approve ${approvalId} allow-always` },
              { label: "Oversized", value: "x".repeat(65) },
            ],
          },
        ],
      },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Generic", value: "generic" }] }],
      },
    });
    expect(rows?.flat().map((button) => button.callback_data)).toEqual([
      `/approve ${approvalId} always`,
    ]);
  });

  it.each([
    { blocks: [{ type: "text", text: "Legacy heading" }] },
    { blocks: [{ type: "buttons", buttons: [{ label: "Oversized", value: "x".repeat(65) }] }] },
  ])(
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
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Raw", value: "/approve req-1 allow-once" },
            {
              label: "Command",
              action: { type: "command", command: "/approve req-1 allow-once" },
            },
            {
              label: "Oversized",
              action: { type: "command", command: `/codex plugins enable ${"x".repeat(80)}` },
            },
          ],
        },
      ],
    });
    expect(rows?.flat().map((button) => button.callback_data)).toEqual([
      "/approve req-1 allow-once",
      "tgcmd:/approve req-1 allow-once",
    ]);
  });

  it("keeps typed callback values opaque, including slash text, whitespace and delimiters", () => {
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Slash", action: { type: "callback", value: "/not-a-native-command" } },
            { label: "Value", action: { type: "callback", value: "env | prod" } },
            {
              label: "Approval",
              action: { type: "callback", value: "/approve plugin:123 allow-once" },
            },
          ],
        },
      ],
    });
    const callbacks = rows?.flat().map((button) => button.callback_data);
    expect(callbacks?.map(parseTelegramOpaqueCallbackData)).toEqual([
      "/not-a-native-command",
      "env | prod",
      "/approve plugin:123 allow-once",
    ]);
    for (const callback of callbacks ?? []) {
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
    const rows = buildTelegramPresentationButtons({
      blocks: [{ type: "buttons", buttons: values.map((value) => ({ label: "Plugin", value })) }],
    });
    const callbacks = rows?.flat().map((button) => button.callback_data);
    expect(callbacks?.map(parseTelegramOpaqueCallbackData)).toEqual([
      "tga1:e:x:not-a-typed-action",
      " tga1:e:o:plugin:123 ",
      "tgq1:ask_0123456789abcdef0123456789abcdef:0",
      " tgq1:ask_0123456789abcdef0123456789abcdef:0 ",
    ]);
    for (const callback of callbacks ?? []) {
      expect(parseTelegramApprovalCallbackData(callback)).toBeNull();
      expect(parseTelegramQuestionCallbackData(callback)).toBeNull();
    }
  });

  it("keeps legacy values that look like opaque callback prefixes raw", () => {
    const rows = buildTelegramPresentationButtons({
      blocks: [{ type: "buttons", buttons: [{ label: "Raw", value: "tgcb1:inspect:123" }] }],
    });
    expect(rows?.[0]?.[0]?.callback_data).toBe("tgcb1:inspect:123");
    expect(parseTelegramOpaqueCallbackData(rows?.[0]?.[0]?.callback_data)).toBeNull();
  });

  it("shortens legacy allow-always before prefixing and retains the approval overflow path", () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const approvalId = `plugin:${"a".repeat(36)}`;
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [uuid, approvalId].map((id) => ({
            label: "Always",
            action: { type: "command" as const, command: `/approve ${id} allow-always` },
          })),
        },
      ],
    });
    expect(rows?.flat().map((button) => button.callback_data)).toEqual([
      `tgcmd:/approve ${uuid} always`,
      `/approve ${approvalId} always`,
    ]);
  });

  it("encodes typed approvals with explicit kind, decision, and exact id", () => {
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "plugin:id/with:delimiters",
                approvalKind: "exec",
                decision: "allow-always",
              },
            },
          ],
        },
      ],
    });
    expect(parseTelegramApprovalCallbackData(rows?.[0]?.[0]?.callback_data)).toEqual({
      type: "approval",
      approvalId: "plugin:id/with:delimiters",
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it("compacts an overlong approval callback and keeps the Review URL", () => {
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "x".repeat(56),
                approvalKind: "exec",
                decision: "allow-once",
              },
            },
            {
              label: "Review",
              action: { type: "url", url: "https://gateway.example/approve/long-id" },
            },
          ],
        },
      ],
    });
    expect(parseTelegramApprovalCallbackData(rows?.[0]?.[0]?.callback_data)).toEqual({
      type: "approval",
      approvalId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(rows?.[0]?.[1]?.url).toBe("https://gateway.example/approve/long-id");
  });

  it("lets canonical typed actions override deprecated button fields", () => {
    const rows = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Open",
              action: { type: "url", url: "https://example.com/canonical" },
              value: "legacy-callback",
              url: "https://example.com/legacy",
            },
          ],
        },
      ],
    });
    expect(rows?.[0]?.[0]?.url).toBe("https://example.com/canonical");
    expect(rows?.[0]?.[0]?.callback_data).toBeUndefined();
  });

  it("keeps question option indices independent and stable across presentation blocks", () => {
    const firstQuestionId = "ask_0123456789abcdef0123456789abcdef";
    const secondQuestionId = "ask_fedcba9876543210fedcba9876543210";
    const questionButton = (questionId: string, optionValue: string) => ({
      label: optionValue,
      action: { type: "question" as const, questionId, optionValue },
    });
    const rows = buildTelegramPresentationButtons(
      {
        blocks: [
          {
            type: "buttons",
            buttons: [
              questionButton(firstQuestionId, "東京"),
              questionButton(firstQuestionId, "Déployer"),
            ],
          },
          {
            type: "buttons",
            buttons: [
              questionButton(secondQuestionId, "東京"),
              questionButton(secondQuestionId, "Production"),
            ],
          },
          {
            type: "buttons",
            buttons: [
              questionButton(firstQuestionId, "東京"),
              questionButton(firstQuestionId, "Production 🚀"),
            ],
          },
        ],
      },
      {
        questionOptionIndices: new Map([
          [
            firstQuestionId,
            new Map([
              ["東京", 0],
              ["déployer", 1],
              ["production 🚀", 2],
            ]),
          ],
          [
            secondQuestionId,
            new Map([
              ["東京", 0],
              ["production", 1],
            ]),
          ],
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
