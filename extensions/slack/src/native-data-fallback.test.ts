import { describe, expect, it } from "vitest";
import { SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT } from "./limits.js";
import {
  buildSlackNativeDataDeliveryPlan,
  chunkSlackTextAtHardLimit,
} from "./native-data-fallback.js";

function tableBlock(caption: string) {
  return {
    type: "data_table",
    caption,
    rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
  } as never;
}

function actionBlock(label: string, value: string) {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "openclaw:reply_button",
        text: { type: "plain_text", text: label },
        value,
      },
    ],
  } as never;
}

describe("buildSlackNativeDataDeliveryPlan", () => {
  it.each([false, true])(
    "bounds derived text without losing dense select controls (native data: %s)",
    (includeNativeData) => {
      const controls = {
        type: "actions" as const,
        block_id: "choose-targets",
        elements: Array.from({ length: 6 }, (_, selectIndex) => ({
          type: "static_select" as const,
          action_id: `choose-target-${selectIndex}`,
          placeholder: { type: "plain_text" as const, text: "Choose target" },
          options: Array.from({ length: 100 }, (_option, optionIndex) => ({
            text: {
              type: "plain_text" as const,
              text: `${selectIndex}-${optionIndex}: `.padEnd(75, "x"),
            },
            value: `target-${selectIndex}-${optionIndex}`,
          })),
        })),
      };
      const originalControls = structuredClone(controls);
      const plan = buildSlackNativeDataDeliveryPlan({
        blocks: includeNativeData ? [controls, tableBlock("Pipeline")] : [controls],
      });

      expect(plan.accessibilityText.length).toBeGreaterThan(0);
      expect(plan.accessibilityText.length).toBeLessThanOrEqual(40_000);
      expect(plan.fallbackMessages.length).toBeGreaterThan(0);
      for (const message of plan.fallbackMessages) {
        expect(message.text.length).toBeGreaterThan(0);
        expect(message.text.length).toBeLessThanOrEqual(40_000);
      }
      const deliveredControls = plan.fallbackMessages
        .flatMap((message) => message.blocks ?? [])
        .filter((block) => block.type === "actions");
      expect(deliveredControls).toEqual([originalControls]);
      expect(controls).toEqual(originalControls);
      if (includeNativeData) {
        expect(plan.fallbackMessages.map((message) => message.text).join("\n")).toContain(
          "Pipeline (table)\nAccount\nAcme",
        );
      }
    },
  );

  it("preserves long select accessibility on a native section accessory", () => {
    const labels = Array.from(
      { length: 100 },
      (_entry, index) => `${index}: ${"Choice ".repeat(9)}`,
    );
    const block = {
      type: "section" as const,
      text: { type: "plain_text" as const, text: "Choose target" },
      accessory: {
        type: "static_select" as const,
        action_id: "choose-target",
        placeholder: { type: "plain_text" as const, text: "Target" },
        options: labels.map((label, index) => ({
          text: { type: "plain_text" as const, text: label },
          value: String(index),
        })),
      },
    };
    const plan = buildSlackNativeDataDeliveryPlan({ blocks: [block] });
    expect(plan.fallbackMessages).toHaveLength(1);
    expect(plan.fallbackMessages[0]?.blocks).toEqual([block]);
    for (const label of labels) {
      expect(plan.accessibilityText).toContain(label.trim());
      expect(plan.fallbackMessages[0]?.text).toContain(label.trim());
    }
  });

  it("uses the generic accessibility label for non-data blocks without visible text", () => {
    const plan = buildSlackNativeDataDeliveryPlan({ blocks: [{ type: "divider" } as never] });

    expect(plan.accessibilityText).toBe("Shared a Block Kit message");
    expect(plan.skipOriginalBlocks).toBe(false);
  });

  it("caps native-only emergency text at Slack's recommended post limit", () => {
    const caption = "x".repeat(41_000);
    const plan = buildSlackNativeDataDeliveryPlan({
      blocks: [tableBlock(caption)],
      textLimit: 8_000,
    });

    expect(plan.skipOriginalBlocks).toBe(true);
    expect(plan.fallbackMessages).toHaveLength(11);
    expect(plan.fallbackMessages.every((message) => message.blocks === undefined)).toBe(true);
    expect(
      plan.fallbackMessages.every(
        (message) => message.text.length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT,
      ),
    ).toBe(true);
    expect(plan.fallbackMessages.map((message) => message.text).join("")).toBe(
      `${caption} (table)\nAccount\nAcme`,
    );
  });

  it("batches survivor controls and replacement sections without changing block order", () => {
    const before = actionBlock("Before", "hidden-before");
    const after = actionBlock("After", "hidden-after");
    const caption = "x".repeat(80_000);
    const plan = buildSlackNativeDataDeliveryPlan({
      baseText: "Intro",
      blocks: [before, tableBlock(caption), after],
      textLimit: 8_000,
    });

    const messages = plan.fallbackMessages;
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => (message.blocks?.length ?? 0) <= 50)).toBe(true);
    expect(
      messages.every((message) => message.text.length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT),
    ).toBe(true);
    const blocks = messages.flatMap((message) => message.blocks ?? []);
    expect(blocks[1]).toBe(before);
    expect(blocks.at(-1)).toBe(after);
    const plainText = blocks.flatMap((block) => {
      const text = (block as { text?: { type?: string; text?: string } }).text;
      return text?.type === "plain_text" && text.text ? [text.text] : [];
    });
    expect(plainText.join("")).toBe(`Intro${caption} (table)\nAccount\nAcme`);
    expect(messages.map((message) => message.text).join(" ")).not.toContain("hidden-");
  });

  it("keeps survivor plain text literal when formatting is disabled", () => {
    const plan = buildSlackNativeDataDeliveryPlan({
      blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: "1 < 2 & <@U123>" },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Keep <literal>" },
          },
        } as never,
        tableBlock("Pipeline"),
      ],
    });

    expect(plan.fallbackMessages[0]?.mrkdwn).toBe(false);
    expect(plan.fallbackMessages[0]?.text).toContain("1 < 2 & <@U123>");
    expect(plan.fallbackMessages[0]?.text).toContain("Keep <literal>");
    expect(plan.fallbackMessages[0]?.text).not.toContain("&lt;");
  });

  it("does not split astral characters at hard boundaries", () => {
    expect(chunkSlackTextAtHardLimit(`A${"😀".repeat(3)}Z`, 3)).toEqual(["A😀", "😀", "😀Z"]);
  });

  it("honors a one-character fallback limit while preserving Unicode scalars", () => {
    expect(chunkSlackTextAtHardLimit("ab😀", 1)).toEqual(["a", "b", "😀"]);

    const plan = buildSlackNativeDataDeliveryPlan({
      blocks: [tableBlock("ab")],
      textLimit: 1,
    });
    expect(plan.fallbackMessages.every((message) => message.text.length === 1)).toBe(true);
    expect(plan.fallbackMessages.map((message) => message.text).join("")).toBe(
      "ab (table)\nAccount\nAcme",
    );
  });

  it("keeps a visible failure marker for malformed native-only data with base text", () => {
    const plan = buildSlackNativeDataDeliveryPlan({
      baseText: "Overview",
      blocks: [{ type: "data_table", rows: [] } as never],
    });

    expect(plan.accessibilityText).toBe(
      "Overview\n\nSlack could not render this chart or table data.",
    );
    expect(plan.fallbackMessages).toEqual([{ text: plan.accessibilityText, mrkdwn: false }]);
  });
});
