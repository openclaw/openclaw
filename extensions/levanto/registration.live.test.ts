import assert from "node:assert/strict";
import {
  validateDecisionResultV2,
  type DecisionBatchV2,
  type DecisionBatchResultV2,
} from "openclaw/plugin-sdk/decisions";
import { getImageMetadata } from "openclaw/plugin-sdk/media-runtime";
import { expect, it } from "vitest";
import { registerLevantoTestProvider } from "./registration.test-support.js";

// The same synthetic 32x32 red square, encoded once with Rastermill's internal codecs.
const images = {
  png: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAQEBAQEBAQEBgHXhUDfhqRFDd3gAAAABJRU5ErkJggg==",
  jpeg: "data:image/jpeg;base64,/9j/wAARCAAgACADAREAAhEBAxEB/9sAQwAFAwQEBAMFBAQEBQUFBgcMCAcHBwcPCwsJDBEPEhIRDxERExYcFxMUGhURERghGBodHR8fHxMXIiQiHiQcHh8e/9sAQwEFBQUHBgcOCAgOHhQRFB4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyvzk/ssKACgAoAKACgAoAKACgAoAKACgAoAKACgAoA//2Q==",
  webp: "data:image/webp;base64,UklGRm4AAABXRUJQVlA4TGIAAAAvH8AHEM1VICICHkgAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABA8kAAAAAADg/AMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI1L2Aw==",
};

const questions: DecisionBatchV2["questions"] = {
  red: { type: "boolean", instructions: "Is the object red?" },
  color: {
    type: "choice",
    instructions: "What color is the object?",
    criteria: { red: "Red", blue: "Blue" },
  },
  count: {
    type: "score",
    instructions: "How many objects?",
    criteria: ["None", "One", "Two"],
  },
  tags: {
    type: "tags",
    criteria: { red: "The object is red", blue: "The object is blue" },
  },
};

function assertReportedUsage(result: DecisionBatchResultV2) {
  const usage = result.usage;
  // Native usage is optional, including for Sort. Preserve it only when supplied.
  if (!usage) {
    return;
  }
  expect(usage).toMatchObject({
    inputTokens: expect.any(Number),
    outputTokens: expect.any(Number),
  });
  expect(usage.raw).toMatchObject({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  });
  expect(usage).not.toHaveProperty("costUsd");
}

it.runIf(process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.LEVANTO_API_KEY))(
  "evaluates native scalar, Tags, Sort and every advertised image MIME through registered Sage",
  async () => {
    const apiKey = process.env.LEVANTO_API_KEY;
    assert(apiKey);
    const provider = registerLevantoTestProvider(getImageMetadata);
    assert(provider?.contractVersion === 2);
    const evaluate = async (name: string, batch: DecisionBatchV2) => {
      // Prepared credentials are fixture input; native transport, media and validation stay real.
      const outcome = await provider.evaluate(batch, {
        model: {
          provider: "levanto",
          id: "levanto-sage",
          name: "Sage",
          baseUrl: "https://sage.levanto.ai",
        },
        config: {},
        auth: { mode: "api-key", apiKey },
        reasoning: "off",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 30_000,
        isAdmissible: () => true,
      });
      assert(outcome.status === "ok", "Sage live evaluation unavailable: " + name);
      expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
      expect(outcome.result.metadata).toHaveProperty("native.meta");
      for (const answer of Object.values(outcome.result.answers)) {
        assert(answer.type !== "error");
        expect(answer.metadata).toHaveProperty("native.kind");
      }
      assertReportedUsage(outcome.result);
      console.info(JSON.stringify({ scenario: name, status: outcome.status }));
      return outcome.result;
    };
    const states: Array<[string, DecisionBatchV2["state"]]> = [
      ["text", { type: "text", text: "The object is a red square." }],
      ...Object.entries(images).map(([mime, dataUri]): [string, DecisionBatchV2["state"]] => [
        mime,
        { type: "image", dataUri },
      ]),
    ];
    for (const [name, state] of states) {
      const result = await evaluate(name, { state, questions });
      // Abstention is valid; per-question errors do not qualify the native contract.
      expect(result.answers.red?.type).toBe("boolean");
      expect(result.answers.color?.type).toBe("choice");
      expect(result.answers.count?.type).toBe("score");
      const tags = result.answers.tags;
      assert(tags?.type === "tags");
      expect(tags.tags.map((tag) => tag.id).toSorted()).toEqual(["blue", "red"]);
      for (const tag of tags.tags) {
        expect(tag.probability).toBeGreaterThanOrEqual(0);
        expect(tag.probability).toBeLessThanOrEqual(1);
        assert(state.type !== "image" || typeof tag.applies === "boolean");
      }
    }
    const sorted = await evaluate("sort", {
      state: {
        type: "list",
        items: [
          { id: "two", content: "2" },
          { id: "one", content: "1" },
          { id: "three", content: "3" },
        ],
      },
      questions: {
        order: { type: "sort", instructions: "Sort by numeric value, smallest first." },
      },
    });
    const order = sorted.answers.order;
    assert(order?.type === "sort");
    expect(order.order.toSorted()).toEqual(["one", "three", "two"]);
    assert(order.confidence == null || (order.confidence >= 0 && order.confidence <= 1));
  },
  180_000,
);
