import { describe, expect, it, vi } from "vitest";
import {
  parseSageBatchResponse,
  parseSageResponse,
  validateSageRequest,
} from "./sage-validation.js";
import type { SageBatchRequest, SageContent, SageQuestion, SageRequest } from "./sage-wire.js";

const yesno: SageQuestion = { id: "gate", kind: "yesno", instructions: "Is this urgent?" };
const choice: SageQuestion = {
  id: "route",
  kind: "choice",
  instructions: "Choose",
  options: [{ option: "a" }, { option: "b" }],
};
const scale: SageQuestion = {
  id: "score",
  kind: "scale",
  instructions: "Score",
  levels: [0, 1, 2, 3, 4].map((level) => ({ level, description: String(level) })),
};
const sort: SageQuestion = { id: "order", kind: "sort", instructions: "Order" };
const tags: SageQuestion = {
  id: "labels",
  kind: "tags",
  tags: [{ id: "a" }, { id: "b", name: "B label" }],
};
const list: SageContent = {
  kind: "list",
  value: [
    { id: "a", content: "A" },
    { id: "b", content: "B" },
  ],
};
// Synthetic one-pixel PNG; the normal media probe is supplied separately, never downloaded.
const image: SageContent = {
  kind: "image",
  media:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
};
const meta = {
  model: "levanto-sage-v1.1",
  usage: { billed_input_tokens: 12, image_count: 0 },
  reasoning: { fired: true, ran: true, finished: false, tokens: 32, limited: "timeout" },
  vendor_extension: { decision_units: 1 },
};
const response = (q: SageQuestion, result: unknown) => ({ id: q.id, kind: q.kind, result, meta });

describe("Sage native protocol", () => {
  it.each([yesno, choice, scale, sort, tags])(
    "validates native $kind without synthesis",
    async (q) => {
      await expect(
        validateSageRequest({ content: q.kind === "sort" ? list : "document", question: q }),
      ).resolves.toBeUndefined();
    },
  );
  it.each(["yes", "no", null])(
    "preserves %s and P(yes), not confidence in the chosen answer",
    (answer) => {
      const value = response(yesno, { answer, probability: 0.03 });
      expect(parseSageResponse(value, yesno, "doc")).toBe(value);
    },
  );
  it("preserves independent option estimates and does not choose an argmax", () => {
    const value = response(choice, {
      chosen: "a",
      probability: 0.7,
      probabilities: [
        { option: "a", probability: 0.7 },
        { option: "b", probability: 0.8 },
      ],
    });
    expect(parseSageResponse(value, choice, "doc")).toBe(value);
    const abstention = response(choice, {
      chosen: null,
      probability: null,
      probabilities: [
        { option: "a", probability: 0.7 },
        { option: "b", probability: 0.8 },
      ],
    });
    expect(parseSageResponse(abstention, choice, "doc")).toBe(abstention);
    const nullableSelected = response(choice, {
      chosen: "a",
      probability: null,
      probabilities: [
        { option: "a", probability: 0.7 },
        { option: "b", probability: 0.8 },
      ],
    });
    expect(parseSageResponse(nullableSelected, choice, "doc")).toBe(nullableSelected);
  });
  it("preserves fractional scale, native sort confidence and text tag abstention", () => {
    for (const [q, c, r] of [
      [scale, "doc", { expectation: 2.4, confidence: 0.71 }],
      [scale, "doc", { expectation: 2.4, confidence: 1.4 }],
      [sort, list, { sorted: ["b", "a"], confidence: null }],
      [
        tags,
        "doc",
        {
          tags: [
            { id: "b", probability: 0.8, applies: true },
            { id: "a", probability: 0.49, applies: null },
          ],
        },
      ],
    ] as const) {
      const v = response(q, r);
      expect(parseSageResponse(v, q, c)).toBe(v);
    }
  });
  it.each([
    [yesno, { answer: true, probability: 0.8 }],
    [yesno, { answer: null, probability: Number.NaN }],
    [yesno, { answer: "yes", probability: 1.1 }],
    [choice, { chosen: "unknown", probability: 0.8, probabilities: [] }],
    [
      choice,
      {
        chosen: null,
        probability: 0,
        probabilities: [
          { option: "a", probability: 0.5 },
          { option: "b", probability: 0.5 },
        ],
      },
    ],
    [
      choice,
      {
        chosen: null,
        probability: null,
        probabilities: [
          { option: "b", probability: 0.5 },
          { option: "a", probability: 0.5 },
        ],
      },
    ],
    [scale, { expectation: 4.01, confidence: 0.5 }],
    [scale, { expectation: 2, confidence: "0.5" }],
    [sort, { sorted: ["a", "a"] }],
    [sort, { sorted: ["a", "other"] }],
    [
      tags,
      {
        tags: [
          { id: "a", probability: 0.5 },
          { id: "b", probability: 0.5, applies: false },
        ],
      },
    ],
    [
      tags,
      {
        tags: [
          { id: "a", probability: 0.5, applies: true },
          { id: "a", probability: 0.5, applies: false },
        ],
      },
    ],
  ] as const)("rejects malformed native result %#", (q, r) => {
    expect(() => parseSageResponse(response(q, r), q, q.kind === "sort" ? list : "doc")).toThrow(
      "Invalid Sage",
    );
  });
  it("rejects wrong IDs, kinds and malformed metadata", () => {
    const v = response(yesno, { answer: null, probability: 0.5 });
    for (const patch of [
      { id: "other" },
      { kind: "choice" },
      { meta: [] },
      { meta: { usage: { billed_input_tokens: -1 } } },
      { meta: { reasoning: { fired: "yes", ran: false } } },
    ]) {
      expect(() => parseSageResponse({ ...v, ...patch }, yesno, "doc")).toThrow("Invalid Sage");
    }
  });
  it("retains serializable grouped partial errors and call-level usage", async () => {
    const request: SageBatchRequest = {
      reasoning: "off",
      requests: [
        { content: "A", questions: [yesno, choice] },
        { content: "B", questions: [yesno] },
      ],
    };
    await validateSageRequest(request);
    const value = {
      results: [
        {
          answers: [
            { ok: true, result: response(yesno, { answer: null, probability: 0.51 }) },
            { ok: false, error: "Service unavailable", result: null },
          ],
        },
        { answers: [{ ok: true, result: response(yesno, { answer: "no", probability: 0.1 }) }] },
      ],
      meta: { ...meta, request_count: 2, question_count: 3 },
    };
    const encoded = JSON.stringify(parseSageBatchResponse(value, request));
    expect(JSON.parse(encoded)).toEqual(value);
    expect(() =>
      parseSageBatchResponse({ ...value, results: value.results.slice(1) }, request),
    ).toThrow();
    expect(() =>
      parseSageBatchResponse({ ...value, meta: { ...value.meta, question_count: 2 } }, request),
    ).toThrow();
    value.results[0]!.answers[0] = { ok: true, result: response(choice, {}) };
    expect(() => parseSageBatchResponse(value, request)).toThrow("correlation");
  });
  it("keeps grounding omitted, empty or explicit without adding defaults", async () => {
    for (const grounding of [
      undefined,
      {},
      { return_sources: false },
      { trigger: "never" as const },
    ]) {
      const r = {
        content: "doc",
        question: yesno,
        ...(grounding === undefined ? {} : { grounding }),
      };
      const before = JSON.stringify(r);
      await validateSageRequest(r);
      expect(JSON.stringify(r)).toBe(before);
    }
  });
  it.each([
    { content: "doc", question: { ...choice, options: [{ option: "a" }] } },
    { content: "doc", question: { ...scale, levels: [0, 1, 2, 3, 3].map((level) => ({ level })) } },
    {
      content: "doc",
      question: { ...scale, levels: [0, 1, 2, 3, 4.5].map((level) => ({ level })) },
    },
    { content: "doc", question: { ...tags, tags: [] } },
    { content: "doc", question: sort },
    { content: list, question: sort, grounding: {} },
    { content: list, question: { ...sort, strategy: "pairwise" } },
    { content: "doc", question: yesno, model: "levanto-sage-v1.1" },
    { content: "doc", question: yesno, reasoning: "low" },
    { requests: [{ content: "doc", questions: [yesno], grounding: {} }] },
  ])("rejects unsupported native request %#", async (r) => {
    await expect(validateSageRequest(r as SageRequest)).rejects.toThrow("Invalid Sage");
  });
  it("enforces text and image choice limits, dimensions, MIME and combinations", async () => {
    const probe = vi.fn(async () => ({ width: 1, height: 1 }));
    const q = {
      ...choice,
      options: Array.from({ length: 120 }, (_, i) => ({ option: String(i) })),
    };
    await validateSageRequest({ content: "doc", question: q });
    await expect(
      validateSageRequest({
        content: "doc",
        question: { ...q, options: [...q.options, { option: "overflow" }] },
      }),
    ).rejects.toThrow("count");
    await validateSageRequest(
      { content: image, question: { ...q, options: q.options.slice(0, 20) } },
      probe,
    );
    await expect(
      validateSageRequest(
        { content: image, question: { ...q, options: q.options.slice(0, 21) } },
        probe,
      ),
    ).rejects.toThrow("count");
    for (const r of [
      { content: image, question: sort },
      { content: image, question: yesno, grounding: {} },
      {
        content: {
          kind: "list",
          value: [
            { id: "a", content: image },
            { id: "b", content: "B" },
          ],
        },
        question: sort,
      },
    ]) {
      await expect(validateSageRequest(r as SageRequest, probe)).rejects.toThrow("Invalid Sage");
    }
    await expect(validateSageRequest({ content: image, question: yesno })).rejects.toThrow(
      "probe required",
    );
    for (const dimensions of [
      { width: 8193, height: 1 },
      { width: 8192, height: 4096 },
      { width: 0, height: 1 },
    ]) {
      await expect(
        validateSageRequest({ content: image, question: yesno }, async () => dimensions),
      ).rejects.toThrow("image");
    }
    for (const media of [
      "https://example.com/a.png",
      "data:image/gif;base64,R0lGODlh",
      "data:image/png;base64,AAAA",
      "data:image/png;base64," + "A".repeat(4 * Math.ceil((4 * 1024 * 1024) / 3) + 4),
    ]) {
      await expect(
        validateSageRequest({ content: { kind: "image", media }, question: yesno }, probe),
      ).rejects.toThrow("image");
    }
    const v = response(tags, {
      tags: [
        { id: "a", probability: 0.5, applies: null },
        { id: "b", probability: 0.8, applies: true },
      ],
    });
    expect(() => parseSageResponse(v, tags, image)).toThrow("tag applies");
  });
});
