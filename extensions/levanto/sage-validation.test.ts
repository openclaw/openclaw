import { expect, it, vi } from "vitest";
import { parseSageBatchResponse, parseSageResponse, validateSageImage } from "./sage-validation.js";
import type { SageBatchRequest, SageContent, SageQuestion } from "./sage-wire.js";

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
  value: ["a", "b"].map((id) => ({ id, content: id.toUpperCase() })),
};
// Synthetic one-pixel PNG; the normal media probe is supplied separately, never downloaded.
const image = {
  kind: "image",
  media:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
} satisfies SageContent;
const meta = {
  model: "levanto-sage-v1.3",
  usage: { input_tokens: 12, output_tokens: 33, image_count: 0 },
  reasoning: { ran: true, finished: false, tokens: 32, limited: "timeout", forced: false },
  vendor_extension: { request_class: "synthetic" },
};
const response = (q: SageQuestion, result: unknown) => ({ id: q.id, kind: q.kind, result, meta });
const choiceResult = (chosen: string | null, probability: number | null, a = 0.7, b = 0.3) => ({
  chosen,
  probability,
  probabilities: [a, b].map((estimate, i) => ({ option: ["a", "b"][i], probability: estimate })),
});
const abstention = choiceResult(null, null, 0.5, 0.5);
const tag = (id: string, probability: number, applies?: boolean | null) => ({
  id,
  probability,
  ...(applies === undefined ? {} : { applies }),
});
const scaleResult = {
  expectation: 2.89,
  confidence: 0.66,
  probabilities: [0, 0.01, 0.12, 0.84, 0.03].map((probability, level) => ({ level, probability })),
};
const scaleWith = (patch: object) => ({ ...scaleResult, ...patch });
const badScale = [{ level: 0, probability: 1.1 }, ...scaleResult.probabilities.slice(1)];
const ok = (q: SageQuestion, result: unknown) => ({ ok: true, result: response(q, result) });

it.each([
  ...["yes", "no", null].map((answer) => [yesno, "doc", { answer, probability: 0.03 }] as const),
  [choice, "doc", choiceResult("a", 0.7)],
  [choice, "doc", choiceResult(null, null, 0.49, 0.51)],
  [choice, "doc", choiceResult("a", null)],
  [scale, "doc", scaleResult],
  [tags, "doc", { tags: [tag("b", 0.8, true), tag("a", 0.49, null)] }],
] as const)("preserves native estimates and abstention %#", (q, content, result) => {
  const value = response(q, result);
  expect(parseSageResponse(value, q, content)).toBe(value);
});
it.each([
  [yesno, { answer: true, probability: 0.8 }],
  [yesno, { answer: null, probability: Number.NaN }],
  [yesno, { answer: "yes", probability: 1.1 }],
  [choice, { chosen: "unknown", probability: 0.8, probabilities: [] }],
  [choice, choiceResult(null, 0, 0.5, 0.5)],
  [choice, { ...abstention, probabilities: abstention.probabilities.toReversed() }],
  [scale, scaleWith({ expectation: 4.01 })],
  [scale, scaleWith({ confidence: "0.5" })],
  [scale, scaleWith({ probabilities: undefined })],
  [scale, scaleWith({ probabilities: scaleResult.probabilities.slice(1) })],
  [scale, scaleWith({ probabilities: scaleResult.probabilities.toReversed() })],
  [scale, scaleWith({ probabilities: badScale })],
  [sort, { sorted: ["a", "a"] }],
  [sort, { sorted: ["a", "other"] }],
  [tags, { tags: [tag("a", 0.5), tag("b", 0.5, false)] }],
  [tags, { tags: [tag("a", 0.5, true), tag("a", 0.5, false)] }],
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
    { meta: { usage: { input_tokens: -1, output_tokens: 1 } } },
    { meta: { usage: { input_tokens: 1, output_tokens: -1 } } },
    { meta: { usage: { input_tokens: 1 } } },
    { meta: { reasoning: { ran: "yes" } } },
    { meta: { reasoning: { ran: true, forced: "yes" } } },
  ]) {
    expect(() => parseSageResponse({ ...v, ...patch }, yesno, "doc")).toThrow("Invalid Sage");
  }
});
it("retains serializable grouped partial errors and call-level usage", () => {
  const request: SageBatchRequest = {
    reasoning: "off",
    requests: [[yesno, choice], [yesno]].map((questions) => ({ content: "doc", questions })),
  };
  const value = {
    results: [
      {
        answers: [
          ok(yesno, { answer: null, probability: 0.51 }),
          { ok: false, error: "Service unavailable", result: null },
        ],
      },
      { answers: [ok(yesno, { answer: "no", probability: 0.1 })] },
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
  value.results[0]!.answers[0] = ok(choice, {});
  expect(() => parseSageBatchResponse(value, request)).toThrow("correlation");
});
it("validates the admitted image signature and native dimension limits", async () => {
  const probe = vi.fn(async () => ({ width: 1, height: 1 }));
  await validateSageImage(image.media, probe);
  expect(probe).toHaveBeenCalledOnce();
  for (const dimensions of [
    { width: 8193, height: 1 },
    { width: 8192, height: 4096 },
    { width: 0, height: 1 },
  ]) {
    await expect(validateSageImage(image.media, async () => dimensions)).rejects.toThrow("image");
  }
  for (const media of [
    "data:image/png;base64,AA==",
    image.media.replace("image/png", "image/jpeg"),
  ]) {
    await expect(validateSageImage(media, probe)).rejects.toThrow("image");
  }
});
it("requires explicit applicability in native image tag results", () => {
  const v = response(tags, { tags: [tag("a", 0.5, null), tag("b", 0.8, true)] });
  expect(() => parseSageResponse(v, tags, image)).toThrow("tag applies");
});
