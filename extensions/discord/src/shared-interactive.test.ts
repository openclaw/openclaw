import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type {
  MessagePresentationButton,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { parseExecApprovalData } from "./approval-custom-id.js";
import { buildDiscordActivityCustomId } from "./component-custom-id.js";
import { buildDiscordComponentMessage } from "./components.js";
import type { DiscordComponentButtonSpec } from "./components.types.js";
import { parseCustomId } from "./internal/components.base.js";
import {
  buildDiscordInteractiveComponents,
  buildDiscordPresentationComponents,
} from "./shared-interactive.js";

function renderButtons(
  buttons: MessagePresentationButton[],
  options?: Parameters<typeof buildDiscordPresentationComponents>[1],
) {
  return buildDiscordPresentationComponents({ blocks: [{ type: "buttons", buttons }] }, options);
}
function legacyButtons(buttons: MessagePresentationButton[]) {
  return buildDiscordInteractiveComponents({ blocks: [{ type: "buttons", buttons }] });
}
function renderSelect(options: MessagePresentationSelectBlock["options"]) {
  return buildDiscordPresentationComponents({
    blocks: [{ type: "select", options, placeholder: "Pick" }],
  });
}
type Approval = Extract<NonNullable<MessagePresentationButton["action"]>, { type: "approval" }>;
const approval = (
  approvalId: string,
  approvalKind: Approval["approvalKind"],
  decision: Approval["decision"],
): Approval => ({ type: "approval", approvalId, approvalKind, decision });
function expectButtons(
  rendered: ReturnType<typeof buildDiscordPresentationComponents>,
  buttons: DiscordComponentButtonSpec[],
) {
  expect(rendered).toEqual({ blocks: [{ type: "actions", buttons }] });
}
const select = (
  callbackDataKind: "command" | "callback",
  options: Array<{ label: string; value: string }>,
) => ({
  blocks: [
    { type: "actions", select: { type: "string", placeholder: "Pick", callbackDataKind, options } },
  ],
});

function firstCustomId(rendered: ReturnType<typeof buildDiscordPresentationComponents>) {
  const block = rendered?.blocks?.[0];
  return block?.type === "actions" ? block.buttons?.[0]?.internalCustomId : undefined;
}
const parseApproval = (id: string) => parseExecApprovalData(parseCustomId(id).data);

describe("buildDiscordInteractiveComponents", () => {
  it("maps shared buttons and selects into Discord component blocks", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "approve", style: "success" },
              { label: "Reject", value: "reject", style: "danger" },
            ],
          },
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "Approve", style: "success", callbackData: "approve" },
            { label: "Reject", style: "danger", callbackData: "reject" },
          ],
        },
        {
          type: "actions",
          select: {
            type: "string",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
        },
      ],
    });
  });

  it("preserves opaque callback authority through the legacy renderer", () => {
    expect(
      legacyButtons([
        {
          label: "Unavailable",
          action: { type: "web-app", widgetId: "invalid" },
        },
        {
          label: "Continue",
          action: { type: "callback", value: "/codex permissions yolo" },
        },
      ]),
    ).toMatchObject({
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Continue",
              callbackData: "/codex permissions yolo",
              callbackDataKind: "callback",
            },
          ],
        },
      ],
    });
  });

  it("renders hosted widget actions as Discord Activity buttons", () => {
    const widgetId = "AAAAAAAAAAAAAAAAAAAAAA";
    expectButtons(
      renderButtons([
        {
          label: "Open widget",
          action: { type: "web-app", widgetId },
        },
      ]),
      [
        {
          label: "Open widget",
          style: "secondary",
          internalCustomId: buildDiscordActivityCustomId(widgetId),
        },
      ],
    );
  });

  it("renders system-agent approvals as actionable Discord controls", () => {
    const rendered = renderButtons([
      {
        label: "Allow Once",
        action: approval("change-1", "system-agent", "allow-once"),
        value: "/approve change-1 allow-once",
        style: "success",
      },
    ]);

    const customId = firstCustomId(rendered);
    expect(customId).toBe("execapproval:kind=system-agent;id=change-1;action=allow-once");
    expect(parseApproval(customId ?? "")).toEqual({
      approvalId: "change-1",
      approvalKind: "system-agent",
      action: "allow-once",
    });
  });

  it("renders typed approvals as actionable transport-private Discord controls", () => {
    const rendered = renderButtons([
      {
        label: "Deny",
        action: approval("opaque:approval;id=7", "plugin", "deny"),
        value: "/approve opaque:approval;id=7 deny",
        style: "danger",
      },
    ]);

    expectButtons(rendered, [
      {
        label: "Deny",
        style: "danger",
        internalCustomId: "execapproval:kind=plugin;id=opaque%3Aapproval%3Bid%3D7;action=deny",
      },
    ]);
    const customId = firstCustomId(rendered);
    expect(customId).toBeDefined();
    if (!rendered) {
      throw new Error("Expected Discord presentation components");
    }
    const built = buildDiscordComponentMessage({ spec: rendered });
    const serialized = built.components[0]?.serialize() as
      | { components?: Array<{ components?: Array<{ custom_id?: string }> }> }
      | undefined;
    expect(serialized?.components?.[0]?.components?.[0]?.custom_id).toBe(customId);
    expect(built.entries).toEqual([]);
    expect(parseApproval(customId ?? "")).toEqual({
      approvalId: "opaque:approval;id=7",
      approvalKind: "plugin",
      action: "deny",
    });
  });

  it("uses declared-choice indices when custom input is interleaved", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    expect(
      renderButtons(
        [
          {
            label: "Production",
            action: { type: "question", questionId, optionValue: "Production" },
          },
          {
            label: "Other…",
            action: { type: "question", questionId, intent: "custom-input" },
          },
          {
            label: "Staging",
            action: { type: "question", questionId, optionValue: "Staging" },
          },
        ],
        {
          questionOptionIndices: new Map([
            [
              questionId,
              new Map([
                ["staging", 0],
                ["production", 1],
              ]),
            ],
          ]),
        },
      ),
    ).toMatchObject({
      blocks: [
        {
          buttons: [
            { internalCustomId: `ocq:id=${questionId};i=1` },
            { internalCustomId: `ocq:id=${questionId};i=0` },
          ],
        },
      ],
    });
  });

  it("rejects malformed approval custom ids and compacts overlong canonical ids", () => {
    expect(parseApproval("execapproval:kind=exec;id=%zz;action=allow-once")).toBeNull();
    expect(parseApproval("execapproval:kind=exec;id=approval-1;action=/approve")).toBeNull();
    const overlongId = `approval/${"\u{1F4F1}".repeat(40)}`;
    const rendered = renderButtons([
      {
        label: "Review",
        action: approval(overlongId, "exec", "allow-once"),
      },
    ]);
    const customId = firstCustomId(rendered);
    expect(customId?.length).toBeLessThanOrEqual(100);
    expect(parseApproval(customId ?? "")).toEqual({
      approvalId: buildApprovalResolutionRef({ approvalId: overlongId, approvalKind: "exec" }),
      approvalKind: "exec",
      action: "allow-once",
    });
    expect(
      renderButtons([
        {
          label: "Invalid",
          action: approval("approval-1", "invalid" as "exec", "allow-once"),
        },
      ]),
    ).toBeUndefined();
  });

  it("splits long shared button rows to stay within Discord action limits", () => {
    expect(
      legacyButtons([
        { label: "One", value: "1" },
        { label: "Two", value: "2" },
        { label: "Three", value: "3" },
        { label: "Four", value: "4" },
        { label: "Five", value: "5" },
        { label: "Six", value: "6" },
      ]),
    ).toEqual({
      blocks: [
        {
          type: "actions",
          buttons: [
            { label: "One", style: "secondary", callbackData: "1" },
            { label: "Two", style: "secondary", callbackData: "2" },
            { label: "Three", style: "secondary", callbackData: "3" },
            { label: "Four", style: "secondary", callbackData: "4" },
            { label: "Five", style: "secondary", callbackData: "5" },
          ],
        },
        {
          type: "actions",
          buttons: [{ label: "Six", style: "secondary", callbackData: "6" }],
        },
      ],
    });
  });

  it("does not duplicate presentation text when appending controls", () => {
    expect(
      buildDiscordPresentationComponents({
        title: "Status",
        blocks: [
          { type: "text", text: "Build completed" },
          { type: "context", text: "main branch" },
          {
            type: "buttons",
            buttons: [{ label: "Open", action: { type: "command", command: "/codex open" } }],
          },
        ],
      }),
    ).toEqual({
      blocks: [
        { type: "text", text: "Status" },
        { type: "text", text: "Build completed" },
        { type: "text", text: "-# main branch" },
        {
          type: "actions",
          buttons: [
            {
              label: "Open",
              style: "secondary",
              callbackData: "/codex open",
              callbackDataKind: "command",
            },
          ],
        },
      ],
    });
  });

  it("preserves disabled presentation buttons for Discord components", () => {
    expectButtons(
      renderButtons([
        { label: "Already handled", value: "done", disabled: true },
        { label: "Open docs", url: "https://example.com/docs", disabled: true },
      ]),
      [
        {
          label: "Already handled",
          style: "secondary",
          callbackData: "done",
          disabled: true,
        },
        {
          label: "Open docs",
          style: "link",
          url: "https://example.com/docs",
          disabled: true,
        },
      ],
    );
  });

  it("preserves reusable presentation buttons for Discord action entries", () => {
    expectButtons(renderButtons([{ label: "Refresh", value: "refresh", reusable: true }]), [
      { label: "Refresh", style: "secondary", callbackData: "refresh", reusable: true },
    ]);
  });

  it.each([
    { kind: "command", label: "Run", value: "/codex permissions yolo" },
    { kind: "callback", label: "Inspect", value: "inspect:123" },
  ] as const)("preserves typed $kind select actions", ({ kind, label, value }) => {
    const action = kind === "command" ? { type: kind, command: value } : { type: kind, value };
    expect(renderSelect([{ label, action, value }])).toEqual(select(kind, [{ label, value }]));
  });

  it("does not render mixed command and callback select actions", () => {
    expect(
      renderSelect([
        {
          label: "Run",
          action: { type: "command", command: "/codex run" },
          value: "/codex run",
        },
        {
          label: "Inspect",
          action: { type: "callback", value: "inspect:123" },
          value: "inspect:123",
        },
      ]),
    ).toBeUndefined();
  });
});
