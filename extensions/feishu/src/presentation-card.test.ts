import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPresentationCard,
  feishuCardWithinTableLimit,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";

describe("buildFeishuPresentationCard", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });
});

describe("Feishu agent controls", () => {
  it("renders a typed callback button a message action authored, and only that one", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Agent", action: { type: "callback", value: "::pick:a" } },
            { label: "Plugin", action: { type: "callback", value: "pick:b" } },
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    const [agent, plugin] = buildFeishuPresentationCard({ presentation }).body.elements as Array<
      Record<string, unknown>
    >;
    expect(agent).toMatchObject({
      tag: "button",
      behaviors: [{ type: "callback", value: expect.objectContaining({ q: "::pick:a" }) }],
    });
    expect(plugin).toEqual({ tag: "markdown", content: "- Plugin" });
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("rejects cyclic cards at the serialization boundary", () => {
    const card: Record<string, unknown> = { schema: "2.0" };
    card.body = card;
    expect(isFeishuCardWithinEnvelope(card)).toBe(false);
  });

  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});

describe("feishuCardWithinTableLimit", () => {
  const table = "| a | b |\n| - | - |\n| 1 | 2 |";

  it("sums tables across all markdown elements of the card", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "hr" },
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(false);
  });
});

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";

describe("Feishu ask_user question buttons", () => {
  it("renders a question button as a callback carrying the option index", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Yes",
              action: { type: "question", questionId: QUESTION_ID, optionValue: "Yes" },
            },
            {
              label: "No",
              action: { type: "question", questionId: QUESTION_ID, optionValue: "No" },
            },
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    const questionOptionIndices = new Map([
      [
        QUESTION_ID,
        new Map([
          ["yes", 0],
          ["no", 1],
        ]),
      ],
    ]);
    const elements = buildFeishuPresentationCard({ presentation, questionOptionIndices }).body
      .elements as Array<Record<string, unknown>>;
    expect(elements[0]).toMatchObject({
      tag: "button",
      behaviors: [
        {
          type: "callback",
          value: {
            oc: "ocf1",
            k: "button",
            a: "feishu.question.answer",
            m: { questionId: QUESTION_ID, optionIndex: 0 },
          },
        },
      ],
    });
    expect(elements[1]).toMatchObject({
      tag: "button",
      behaviors: [{ type: "callback", value: { m: { questionId: QUESTION_ID, optionIndex: 1 } } }],
    });
  });

  it("falls back to text when the Gateway option order is unavailable", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Yes",
              action: { type: "question", questionId: QUESTION_ID, optionValue: "Yes" },
            },
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      { tag: "markdown", content: "- Yes" },
    ]);
  });
});
