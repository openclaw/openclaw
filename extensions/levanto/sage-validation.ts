import { sanitizeInlineImageDataUrl } from "openclaw/plugin-sdk/inline-image-data-url-runtime";
import type {
  SageBatchRequest,
  SageBatchResponse,
  SageContent,
  SageQuestion,
  SageRequest,
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
function keys(value: Record<string, unknown>, allowed: string[], field: string) {
  check(
    Object.keys(value).every((key) => allowed.includes(key)),
    field,
  );
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
function optionalString(value: unknown, field: string) {
  if (value != null) {
    string(value, field);
  }
}
function grounding(value: unknown) {
  if (value == null) {
    return;
  }
  const g = object(value, "grounding");
  keys(
    g,
    ["trigger", "confidence_floor", "max_results", "max_context_tokens", "return_sources"],
    "grounding fields",
  );
  if (g.trigger !== undefined) {
    check(
      typeof g.trigger === "string" && ["never", "low_confidence", "always"].includes(g.trigger),
      "grounding trigger",
    );
  }
  if (g.confidence_floor !== undefined) {
    number(g.confidence_floor, 0, 1, "grounding confidence_floor");
  }
  if (g.max_results !== undefined) {
    integer(g.max_results, 1, 20, "grounding max_results");
  }
  if (g.max_context_tokens !== undefined) {
    integer(g.max_context_tokens, 1, 8000, "grounding max_context_tokens");
  }
  if (g.return_sources !== undefined) {
    check(typeof g.return_sources === "boolean", "grounding return_sources");
  }
}
async function content(value: unknown, probe?: SageImageProbe, inList = false): Promise<void> {
  if (typeof value === "string") {
    return;
  }
  const c = object(value, "content");
  if (c.kind === "text") {
    keys(c, ["kind", "value"], "text fields");
    string(c.value, "text value");
    return;
  }
  if (c.kind === "list") {
    keys(c, ["kind", "value"], "list fields");
    const items = array(c.value, 2, 120, "list length");
    const ids = [];
    for (const item of items) {
      const i = object(item, "list item");
      keys(i, ["id", "content"], "list item fields");
      string(i.id, "list item id");
      ids.push(i.id);
      await content(i.content, probe, true);
    }
    unique(ids, "duplicate list ids");
    return;
  }
  check(c.kind === "image" && !inList, "image placement");
  keys(c, ["kind", "media", "text"], "image fields");
  string(c.media, "image media");
  optionalString(c.text, "image text");
  // Bound before decoding; canonical inline bytes only, never remote URLs.
  check(c.media.length <= 4 * Math.ceil((4 * 1024 * 1024) / 3) + 23, "image byte limit");
  check(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(c.media),
    "image data URI",
  );
  check(sanitizeInlineImageDataUrl(c.media) === c.media, "image encoding or MIME");
  const bytes = Buffer.from(c.media.slice(c.media.indexOf(",") + 1), "base64");
  check(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, "image byte limit");
  check(probe, "image probe required");
  const dimensions = await probe(bytes);
  check(dimensions, "image dimensions");
  integer(dimensions.width, 1, 8192, "image width");
  integer(dimensions.height, 1, 8192, "image height");
  check(dimensions.width * dimensions.height <= 4096 ** 2, "image area");
}
function question(value: unknown, c: unknown, batch: boolean, topGrounding?: unknown) {
  const q = object(value, "question");
  string(q.id, "question id");
  const base = ["kind", "id", "instructions", ...(batch ? ["grounding"] : [])];
  const image = typeof c === "object" && c !== null && "kind" in c && c.kind === "image";
  const g = batch ? q.grounding : topGrounding;
  grounding(g);
  check(!image || g == null, "image with grounding");
  if (q.kind === "tags") {
    optionalString(q.instructions, "instructions");
  } else {
    string(q.instructions, "instructions");
  }
  switch (q.kind) {
    case "yesno":
      keys(q, base, "yesno fields");
      break;
    case "sort":
      keys(q, base, "sort fields");
      check(g == null, "sort with grounding");
      check(
        typeof c === "object" && c !== null && "kind" in c && c.kind === "list",
        "sort requires list",
      );
      break;
    case "choice": {
      keys(q, [...base, "options"], "choice fields");
      const options = array(q.options, 2, image ? 20 : 120, "choice option count").map((v) => {
        const o = object(v, "choice option");
        keys(o, ["option", "description"], "option fields");
        string(o.option, "option");
        optionalString(o.description, "option description");
        return o.option;
      });
      unique(options, "duplicate options");
      break;
    }
    case "scale": {
      keys(q, [...base, "levels"], "scale fields");
      const levels = array(q.levels, 5, 5, "scale level count").map((v) => {
        const l = object(v, "scale level");
        keys(l, ["level", "description"], "level fields");
        integer(l.level, 0, 4, "scale level");
        optionalString(l.description, "level description");
        return l.level;
      });
      unique(levels, "duplicate levels");
      break;
    }
    case "tags": {
      keys(q, [...base, "tags"], "tags fields");
      const tags = array(q.tags, 1, 120, "tag count").map((v) => {
        const t = object(v, "tag");
        keys(t, ["id", "name", "threshold"], "tag fields");
        string(t.id, "tag id");
        optionalString(t.name, "tag name");
        if (t.threshold != null) {
          number(t.threshold, 0, 1, "tag threshold");
        }
        return t.id;
      });
      unique(tags, "duplicate tags");
      break;
    }
    default:
      check(false, "question kind");
  }
}
function reasoning(value: unknown) {
  check(value === undefined || value === "auto" || value === "on" || value === "off", "reasoning");
}
export async function validateSageRequest(
  value: SageRequest | SageBatchRequest,
  probe?: SageImageProbe,
): Promise<void> {
  const r = object(value, "request");
  reasoning(r.reasoning);
  if ("requests" in r) {
    keys(r, ["requests", "reasoning"], "batch fields");
    for (const item of array(r.requests, 1, Infinity, "batch requests")) {
      const group = object(item, "batch group");
      keys(group, ["content", "questions"], "group fields");
      await content(group.content, probe);
      for (const q of array(group.questions, 1, Infinity, "batch questions")) {
        question(q, group.content, true);
      }
    }
  } else {
    keys(r, ["content", "question", "reasoning", "grounding"], "request fields");
    await content(r.content, probe);
    question(r.question, r.content, false, r.grounding);
  }
}
function metadata(value: unknown) {
  const m = object(value, "metadata");
  if (m.model !== undefined) {
    string(m.model, "metadata model");
  }
  optionalString(m.compute_mode, "compute mode");
  if (m.latency_ms != null) {
    number(m.latency_ms, 0, Infinity, "latency");
  }
  if (m.question_count != null) {
    integer(m.question_count, 0, Infinity, "question count");
  }
  if (m.usage != null) {
    const u = object(m.usage, "usage");
    integer(u.billed_input_tokens, 0, Infinity, "billed input tokens");
    if (u.rendered_tokens != null) {
      integer(u.rendered_tokens, 0, Infinity, "usage rendered_tokens");
    }
    for (const k of ["image_count", "image_tokens"]) {
      if (u[k] !== undefined) {
        integer(u[k], 0, Infinity, "usage " + k);
      }
    }
  }
  if (m.reasoning != null) {
    const r = object(m.reasoning, "reasoning metadata");
    check(typeof r.fired === "boolean" && typeof r.ran === "boolean", "reasoning fired/ran");
    if (r.finished != null) {
      check(typeof r.finished === "boolean", "reasoning finished");
    }
    if (r.tokens != null) {
      integer(r.tokens, 0, Infinity, "reasoning tokens");
    }
    if (r.margin != null) {
      number(r.margin, -Infinity, Infinity, "reasoning margin");
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
  optionalString(g.trigger_reason, "grounding trigger reason");
  if (g.queries !== undefined) {
    for (const v of array(g.queries, 0, Infinity, "queries")) {
      string(v, "query");
    }
  }
  if (g.sources !== undefined) {
    for (const v of array(g.sources, 0, Infinity, "sources")) {
      const source = object(v, "source");
      for (const k of ["url", "title", "snippet"]) {
        optionalString(source[k], "source " + k);
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
    case "scale":
      number(r.expectation, 0, 4, "expectation");
      number(r.confidence, -Infinity, Infinity, "confidence");
      break;
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
