import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  SageBatchRequest,
  SageBatchResponse,
  SageContent,
  SageQuestion,
  SageResponse,
} from "./sage-wire.js";

// The caller supplies its normal media probe after authorized media preparation.
// This module never fetches media, opens a path, or trusts caller-supplied dimensions.
export type SageImageProbe = (bytes: Buffer) => Promise<{ width: number; height: number } | null>;
function check(condition: unknown, field: string): asserts condition {
  if (!condition) {
    throw new Error("Invalid Sage " + field);
  }
}
function object(value: unknown, field: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), field);
  // SAFETY: The check above excludes null, primitives and arrays; properties remain unknown.
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): asserts value is string {
  check(typeof value === "string", field);
}
function number(value: unknown, min: number, max: number, field: string): asserts value is number {
  check(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, field);
}
function integer(value: unknown, min: number, max: number, field: string) {
  number(value, min, max, field);
  check(Number.isInteger(value), field);
}
function array(value: unknown, min: number, max: number, field: string): unknown[] {
  check(Array.isArray(value) && value.length >= min && value.length <= max, field);
  return value;
}
function unique(values: unknown[], field: string) {
  check(new Set(values).size === values.length, field);
}
// Native optional fields accept null and preserve empty strings and whitespace.
function assertSageNullableString(value: unknown, field: string) {
  check(value == null || readStringValue(value) !== undefined, field);
}
export async function validateSageImage(media: string, probe: SageImageProbe): Promise<void> {
  // Decision admission already owns canonical encoding and byte limits.
  check(sanitizeInlineImageDataUrl(media) === media, "image encoding or MIME");
  const bytes = Buffer.from(media.slice(media.indexOf(",") + 1), "base64");
  const dimensions = await probe(bytes);
  check(dimensions, "image dimensions");
  integer(dimensions.width, 1, 8192, "image width");
  integer(dimensions.height, 1, 8192, "image height");
  check(dimensions.width * dimensions.height <= 4096 ** 2, "image area");
}
function metadata(value: unknown) {
  const m = object(value, "metadata");
  if (m.model !== undefined) {
    string(m.model, "metadata model");
  }
  assertSageNullableString(m.compute_mode, "compute mode");
  if (m.latency_ms != null) {
    number(m.latency_ms, 0, Infinity, "latency");
  }
  if (m.question_count != null) {
    integer(m.question_count, 0, Infinity, "question count");
  }
  if (m.usage != null) {
    const u = object(m.usage, "usage");
    integer(u.input_tokens, 0, Infinity, "input tokens");
    integer(u.output_tokens, 0, Infinity, "output tokens");
    for (const k of ["image_count", "image_tokens"]) {
      if (u[k] !== undefined) {
        integer(u[k], 0, Infinity, "usage " + k);
      }
    }
  }
  if (m.reasoning != null) {
    const r = object(m.reasoning, "reasoning metadata");
    check(typeof r.ran === "boolean", "reasoning ran");
    if (r.finished != null) {
      check(typeof r.finished === "boolean", "reasoning finished");
    }
    if (r.tokens != null) {
      integer(r.tokens, 0, Infinity, "reasoning tokens");
    }
    if (r.forced !== undefined) {
      check(typeof r.forced === "boolean", "reasoning forced");
    }
    if (r.limited != null) {
      check(
        typeof r.limited === "string" && ["cap", "timeout", "budget"].includes(r.limited),
        "reasoning limited",
      );
    }
  }
}
function groundingMeta(value: unknown) {
  if (value == null) {
    return;
  }
  const g = object(value, "grounding metadata");
  check(typeof g.triggered === "boolean", "grounding triggered");
  assertSageNullableString(g.trigger_reason, "grounding trigger reason");
  if (g.queries !== undefined) {
    for (const v of array(g.queries, 0, Infinity, "queries")) {
      string(v, "query");
    }
  }
  if (g.sources !== undefined) {
    for (const v of array(g.sources, 0, Infinity, "sources")) {
      const source = object(v, "source");
      for (const k of ["url", "title", "snippet"]) {
        assertSageNullableString(source[k], "source " + k);
      }
    }
  }
  if (g.added_context_tokens != null) {
    integer(g.added_context_tokens, 0, Infinity, "grounding tokens");
  }
  if (g.search_ms != null) {
    number(g.search_ms, 0, Infinity, "search latency");
  }
}
export function parseSageResponse(value: unknown, q: SageQuestion, c: SageContent): SageResponse {
  const v = object(value, "response");
  check(v.id === q.id && v.kind === q.kind, "response correlation");
  metadata(v.meta);
  groundingMeta(v.grounding_meta);
  const r = object(v.result, "result");
  switch (q.kind) {
    case "yesno":
      check(r.answer === null || r.answer === "yes" || r.answer === "no", "answer");
      number(r.probability, 0, 1, "probability");
      break;
    case "choice": {
      const options = q.options.map((o) => o.option);
      check(
        r.chosen === null || (typeof r.chosen === "string" && options.includes(r.chosen)),
        "chosen option",
      );
      if (r.chosen === null) {
        check(r.probability === null, "abstention probability");
      } else if (r.probability !== null) {
        number(r.probability, 0, 1, "chosen probability");
      }
      const probabilities = array(
        r.probabilities,
        options.length,
        options.length,
        "option probabilities",
      );
      probabilities.forEach((p, i) => {
        const o = object(p, "option probability");
        check(o.option === options[i], "option correlation");
        number(o.probability, 0, 1, "option probability");
      });
      break;
    }
    case "scale": {
      const levels = q.levels.map((level) => level.level);
      number(r.expectation, Math.min(...levels), Math.max(...levels), "expectation");
      number(r.confidence, -Infinity, Infinity, "confidence");
      const probabilities = array(
        r.probabilities,
        levels.length,
        levels.length,
        "level probabilities",
      );
      probabilities.forEach((p, i) => {
        const estimate = object(p, "level probability");
        check(estimate.level === levels[i], "level correlation");
        number(estimate.probability, 0, 1, "level probability");
      });
      break;
    }
    case "sort": {
      check(typeof c === "object" && c.kind === "list", "sort content");
      const ids = c.value.map((item) => item.id);
      const sorted = array(r.sorted, ids.length, ids.length, "sort length");
      check(
        sorted.every((id) => typeof id === "string" && ids.includes(id)),
        "sort correlation",
      );
      unique(sorted, "duplicate sorted ids");
      if (r.confidence != null) {
        number(r.confidence, 0, 1, "sort confidence");
      }
      break;
    }
    case "tags": {
      const image = typeof c === "object" && c.kind === "image";
      const tags = array(r.tags, q.tags.length, q.tags.length, "result tags");
      const ids = tags.map((t) => {
        const tag = object(t, "result tag");
        check(
          q.tags.some((expected) => expected.id === tag.id),
          "tag correlation",
        );
        number(tag.probability, 0, 1, "tag probability");
        check(typeof tag.applies === "boolean" || (!image && tag.applies === null), "tag applies");
        return tag.id;
      });
      unique(ids, "duplicate result tags");
      break;
    }
  }
  // Keep the original JSON object, including vendor usage/provenance extensions.
  // SAFETY: Transport supplies decoded JSON and a validated question; all native fields and correlation were checked above.
  return value as SageResponse;
}
export function parseSageBatchResponse(
  value: unknown,
  request: SageBatchRequest,
): SageBatchResponse {
  const v = object(value, "batch response");
  metadata(v.meta);
  const m = object(v.meta, "batch metadata");
  check(m.request_count === request.requests.length, "batch request count");
  check(
    m.question_count === request.requests.reduce((n, g) => n + g.questions.length, 0),
    "batch question count",
  );
  const groups = array(
    v.results,
    request.requests.length,
    request.requests.length,
    "batch results",
  );
  request.requests.forEach((expected, i) => {
    const g = object(groups[i], "batch result group");
    const answers = array(
      g.answers,
      expected.questions.length,
      expected.questions.length,
      "batch answers",
    );
    expected.questions.forEach((expectedQuestion, j) => {
      const a = object(answers[j], "batch answer");
      if (a.ok === true) {
        check(a.error == null, "successful answer error");
        parseSageResponse(a.result, expectedQuestion, expected.content);
      } else {
        check(a.ok === false && a.result == null, "failed answer");
        string(a.error, "answer error");
      }
    });
  });
  // SAFETY: Decoded JSON has exact group/answer cardinality, validated native results or error strings, and checked metadata.
  return value as SageBatchResponse;
}
