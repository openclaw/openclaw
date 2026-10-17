import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  findTruncatedSecret,
  getLongestRegisteredSecretLength,
  hasConfiguredRedactPatterns,
  redactSensitiveText,
} from "../api.js";

const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";
const TRUNCATED_TEXT_SUFFIX = "...(truncated)";
// Redaction runs on the event-loop thread, so its cost must follow what an attribute exports,
// not what a model call carries (megabytes of tool output or image data). Clipped text is
// redacted with at least this much context past its export cut: a secret that starts in the
// exported prefix and ends within the lookahead is matched as it would be in the whole text.
const MIN_OTEL_REDACTION_LOOKAHEAD_CHARS = 4096;
// Bounds the clipped text one truncated JSON candidate may send to the redactor, counted as one
// window per clipped string; a candidate over it falls through to the next, smaller budget.
// Masks and quote probes can make a clipped string cost up to five windows.
const MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR = 8;
// A value whose JSON is over the attribute budget can still fit once its secrets are masked: a
// credentials dump shrinks by about half, a log of bearer JWTs by more. JSON up to 4x the budget is
// redacted whole first and exported whole if it then fits. That pass sends each string, then the
// JSON, to the redactor: at most 8x the budget, the cap a truncated candidate has. Built-in rules
// and registered values match over the whole text, so a secret is masked wherever it falls;
// configured patterns run in chunks on long text here as in every whole-value pass.
const MAX_OTEL_WHOLE_JSON_CHARS_PER_EXPORT_CHAR = 4;
// A window that ends inside a secret cannot tell how the redactor masks it: the redactor may mask
// it whole and keep the text after it. Such a string is redacted whole instead, while its export
// has budget left: 8x the export's size, the cap its windows have. Past the budget the secret is
// masked from where it starts, which drops what follows it.
const MAX_OTEL_WHOLE_STRING_CHARS_PER_EXPORT_CHAR = 8;
// Some secrets end with a part the window can cut off, such as a private key's END line or a JWT's
// signature. A secret the window leaves open (`findTruncatedSecret`) is masked from where its value
// starts.
const OPEN_SECRET_MASK = "***";

// Registered secrets only match whole, so the lookahead also covers the longest registered surface
// form (URL-encoded and JSON-escaped forms included). That length widens every clipped string's
// window, so redaction work grows linearly with it. JSON attributes count the wider windows against
// their 8x cap and keep fewer items as it grows; once a single clipped string's window passes the
// cap (a surface form of about 1M characters), they export only the truncation summary.
// Configured `logging.redactPatterns` can need any amount of text past a cut, so with them the
// lookahead is unbounded: every string is redacted whole, without the cap, as main does.
function otelRedactionLookaheadChars(): number {
  if (hasConfiguredRedactPatterns()) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(MIN_OTEL_REDACTION_LOOKAHEAD_CHARS, getLongestRegisteredSecretLength());
}

/** Strings redacted whole for one export, and the characters of them it can still afford. */
type WholeStringRedactions = { budgetChars: number; texts: Map<string, string> };

function wholeStringRedactions(exportChars: number): WholeStringRedactions {
  return {
    budgetChars: exportChars * MAX_OTEL_WHOLE_STRING_CHARS_PER_EXPORT_CHAR,
    texts: new Map(),
  };
}

/** Redacts the part of `value` an export of `keepChars` can show; `clipped` means text was dropped. */
function redactExportPrefix(
  value: string,
  keepChars: number,
  whole: WholeStringRedactions,
): { text: string; clipped: boolean } {
  const wholeText = whole.texts.get(value);
  if (wholeText !== undefined) {
    return { text: wholeText, clipped: false };
  }
  const lookaheadChars = otelRedactionLookaheadChars();
  const neededChars = keepChars + lookaheadChars;
  let redacted = redactWindow(value, neededChars, whole);
  // Masks shorten text, so the export cut can move into the lookahead, where a secret the window
  // cuts off may start. Twice the shortfall restores the lookahead when masks shortened at most
  // half the text. With the first window, redaction work stays within four windows plus probes.
  if (!redacted.settled && redacted.text.length < neededChars) {
    redacted = redactWindow(value, neededChars + 2 * (neededChars - redacted.text.length), whole);
  }
  if (redacted.settled || redacted.text.length >= neededChars) {
    return redacted;
  }
  // Masks only shorten text (values under three characters aside), so keeping a lookahead of
  // redacted text after the export keeps at least that much input after it.
  const exportChars = redacted.text.length - lookaheadChars;
  return { text: truncateUtf16Safe(redacted.text, Math.max(0, exportChars)), clipped: true };
}

/** `settled` means nothing past the window can change the redacted text. */
function redactWindow(
  value: string,
  windowChars: number,
  whole: WholeStringRedactions,
): { text: string; clipped: boolean; settled: boolean } {
  if (value.length <= windowChars) {
    return { text: redactSensitiveText(value), clipped: false, settled: true };
  }
  let clippedText = truncateUtf16Safe(value, windowChars);
  let openSecret = findTruncatedSecret(clippedText);
  if (openSecret && value.length <= whole.budgetChars) {
    whole.budgetChars -= value.length;
    const text = redactSensitiveText(value);
    whole.texts.set(value, text);
    return { text, clipped: false, settled: true };
  }
  if (openSecret && getLongestRegisteredSecretLength() > 0) {
    // Registered values follow no grammar and can hold what reads as an open secret. The
    // redactor masks them before any rule runs, so they are masked whole before the cut is chosen.
    const registeredMasked = redactSensitiveText(clippedText, { mode: "off" });
    if (registeredMasked !== clippedText) {
      clippedText = registeredMasked;
      openSecret = findTruncatedSecret(clippedText);
    }
  }
  if (!openSecret) {
    return { text: redactSensitiveText(clippedText), clipped: true, settled: false };
  }
  const beforeSecret = redactSensitiveText(clippedText.slice(0, openSecret.start));
  return {
    text: `${beforeSecret}${OPEN_SECRET_MASK}${openSecret.closing}`,
    clipped: true,
    settled: true,
  };
}

export function normalizeOtelLogString(value: string, maxChars: number): string {
  const { text, clipped } = redactExportPrefix(value, maxChars, wholeStringRedactions(maxChars));
  return clipped || text.length > maxChars
    ? `${truncateUtf16Safe(text, maxChars)}${TRUNCATED_TEXT_SUFFIX}`
    : text;
}

export function normalizeOtelErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeOtelLogString(value.trim(), MAX_OTEL_ERROR_MESSAGE_CHARS);
  return normalized || undefined;
}

export function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

export function normalizeOtelContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)
      .filter((item): item is string => typeof item === "string");
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  return safeJsonString(value);
}

const JSON_TRUNCATION_STRING_BUDGETS = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32] as const;
const JSON_TRUNCATION_ARRAY_ITEM_BUDGETS = [
  MAX_OTEL_CONTENT_ARRAY_ITEMS,
  100,
  50,
  25,
  10,
  5,
  1,
] as const;
const JSON_TRUNCATION_MAX_OBJECT_FIELDS = 64;
// Each clipped string costs at least the redaction lookahead, so a value with hundreds of strings
// can fit the attribute only at budgets its windows cannot afford. Fewer object fields keep fewer
// strings, each with more of its text.
const JSON_TRUNCATION_CAPPED_OBJECT_FIELD_BUDGETS = [16, 4, 1] as const;
const JSON_TRUNCATION_MAX_DEPTH = 8;

export function safeJsonString(value: unknown): string | undefined {
  if (isOmittedFromJson(value)) {
    return undefined;
  }
  const exact = redactWholeJson(value, new Map());
  if (exact.json !== undefined) {
    return exact.json;
  }
  const whole = wholeStringRedactions(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  let found = searchJsonCandidates(value, JSON_TRUNCATION_MAX_OBJECT_FIELDS, whole);
  let redactionCapped = found.redactionCapped;
  // Every candidate that fit the attribute was over the redaction cap: keep fewer object fields,
  // so fewer strings are clipped and each keeps more of its text.
  for (const maxObjectFields of JSON_TRUNCATION_CAPPED_OBJECT_FIELD_BUDGETS) {
    if (found.json !== undefined || !found.redactionCapped) {
      break;
    }
    found = searchJsonCandidates(value, maxObjectFields, whole);
    redactionCapped ||= found.redactionCapped;
  }
  // Strings masked whole while truncating can make the value fit once they are masked. A value
  // under the whole-value bound already had that pass.
  if (whole.texts.size > 0 && !exact.withinBound) {
    const substituted = redactWholeJson(value, whole.texts);
    if (substituted.json !== undefined) {
      return substituted.json;
    }
  }
  if (found.json !== undefined) {
    return found.json;
  }
  const summary = stringifyJsonForOtelAttribute({
    truncated: true,
    reason: summaryReason(value, redactionCapped),
    type: describeJsonValue(value),
  });
  return summary && summary.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS ? summary : undefined;
}

/**
 * The whole value redacted, if its JSON with `wholeTexts` substituted is within the whole-value
 * bound and the result fits the attribute.
 */
function redactWholeJson(
  value: unknown,
  wholeTexts: ReadonlyMap<string, string>,
): { json?: string; withinBound: boolean } {
  const maxWholeChars =
    MAX_OTEL_CONTENT_ATTRIBUTE_CHARS * MAX_OTEL_WHOLE_JSON_CHARS_PER_EXPORT_CHAR;
  const unredacted = exceedsJsonChars(value, maxWholeChars, wholeTexts)
    ? undefined
    : stringifyJson(value, (_key, field) =>
        typeof field === "string" ? (wholeTexts.get(field) ?? field) : field,
      );
  if (!unredacted || unredacted.length > maxWholeChars) {
    return { withinBound: false };
  }
  const json = stringifyJsonForOtelAttribute(value, wholeTexts);
  return json && json.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS
    ? { json, withinBound: true }
    : { withinBound: true };
}

/** The first truncation candidate that fits the attribute and the redaction cap. */
function searchJsonCandidates(
  value: unknown,
  maxObjectFields: number,
  whole: WholeStringRedactions,
): { json?: string; redactionCapped: boolean } {
  // Pick the budget from unredacted sizes, then redact only the candidate that is exported.
  const lookaheadChars = otelRedactionLookaheadChars();
  const maxRedactionChars = Number.isFinite(lookaheadChars)
    ? MAX_OTEL_CONTENT_ATTRIBUTE_CHARS * MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR
    : Number.POSITIVE_INFINITY;
  let redactionCapped = false;
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      let redactionChars = 0;
      const budget = { maxArrayItems, maxObjectFields };
      const unredacted = stringifyJson(
        truncateJsonValueForOtelAttribute(value, budget, (text) => {
          redactionChars += Math.min(text.length, maxStringChars + lookaheadChars);
          return text.length > maxStringChars ? clipJsonText(text, maxStringChars) : text;
        }),
      );
      if (!unredacted || unredacted.length > MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
        continue;
      }
      if (redactionChars > maxRedactionChars) {
        redactionCapped = true;
        continue;
      }
      const candidate = truncateJsonValueForOtelAttribute(value, budget, (text) =>
        truncateJsonTextForOtelAttribute(text, maxStringChars, whole),
      );
      const json = stringifyJsonForOtelAttribute(candidate);
      if (json && json.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
        return { json, redactionCapped };
      }
    }
  }
  return { redactionCapped };
}

// A candidate that fit the attribute but not the redaction cap was dropped for its redaction
// cost, not its size.
function summaryReason(value: unknown, redactionCapped: boolean): string {
  if (!stringifyJson(value)) {
    return "unserializable_value";
  }
  return redactionCapped ? "max_redaction_work" : "max_attribute_size";
}

function isOmittedFromJson(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

// Lower bound on JSON.stringify(value).length, with `wholeTexts` substituted for the strings they
// hold, walked only until it passes maxChars: every emitted value takes a character and every
// emitted string or key appears at least once.
function exceedsJsonChars(
  value: unknown,
  maxChars: number,
  wholeTexts: ReadonlyMap<string, string>,
): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let chars = 0;
  while (pending.length > 0 && chars <= maxChars) {
    const item = pending.pop();
    chars += typeof item === "string" ? (wholeTexts.get(item) ?? item).length + 2 : 1;
    if (typeof item !== "object" || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length && chars <= maxChars; index++) {
        chars += 1;
        pending.push(item[index]);
      }
      continue;
    }
    for (const [key, field] of Object.entries(item)) {
      if (chars > maxChars) {
        break;
      }
      if (!isOmittedFromJson(field)) {
        chars += key.length + 3;
        pending.push(field);
      }
    }
  }
  return chars > maxChars;
}

function stringifyJson(
  value: unknown,
  replacer?: (key: string, field: unknown) => unknown,
): string | undefined {
  try {
    return JSON.stringify(value, replacer) || undefined;
  } catch {
    return undefined;
  }
}

// With `wholeTexts`, strings are redacted on their own as well as inside the serialized JSON:
// escaping rewrites line breaks and quotes, which hides assignments that start a line from the
// text rules. A string already redacted whole is not redacted again.
function stringifyJsonForOtelAttribute(
  value: unknown,
  wholeTexts?: ReadonlyMap<string, string>,
): string | undefined {
  try {
    const json = JSON.stringify(
      value,
      wholeTexts
        ? (_key, field: unknown) =>
            typeof field === "string"
              ? (wholeTexts.get(field) ?? redactSensitiveText(field))
              : field
        : undefined,
    );
    if (!json) {
      return undefined;
    }
    return redactSensitiveText(json);
  } catch {
    return undefined;
  }
}

// `truncateText` clips each string to the candidate's string budget; the budget search counts
// redaction work with one callback and exports with another.
function truncateJsonValueForOtelAttribute(
  input: unknown,
  budget: { maxArrayItems: number; maxObjectFields: number },
  truncateText: (value: string) => string,
): unknown {
  const { maxArrayItems, maxObjectFields } = budget;
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string" || typeof value === "bigint") {
      return truncateText(String(value));
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (typeof value !== "object") {
      return undefined;
    }
    if (depth <= 0) {
      return { truncated: true, reason: "max_depth" };
    }
    if (seen.has(value)) {
      const marker = { truncated: true, reason: "circular_reference" };
      return Array.isArray(value) ? [marker] : marker;
    }
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const items = value.slice(0, maxArrayItems).map((item) => visit(item, depth - 1));
      if (value.length > items.length) {
        items.push({ truncated: true, omittedItems: value.length - items.length });
      }
      result = items;
    } else {
      const object: Record<string, unknown> = {};
      const entries = Object.entries(value).filter(([, field]) => !isOmittedFromJson(field));
      for (const [key, field] of entries.slice(0, maxObjectFields)) {
        object[key] = visit(field, depth - 1);
      }
      if (entries.length > maxObjectFields) {
        object.truncated = true;
        object.omittedFields = entries.length - maxObjectFields;
      }
      result = object;
    }
    seen.delete(value);
    return result;
  }
  return visit(input, JSON_TRUNCATION_MAX_DEPTH);
}

function clipJsonText(value: string, maxChars: number): string {
  const suffixBudget = Math.min(TRUNCATED_TEXT_SUFFIX.length, maxChars);
  const prefixBudget = Math.max(0, maxChars - suffixBudget);
  return `${truncateUtf16Safe(value, prefixBudget)}${TRUNCATED_TEXT_SUFFIX.slice(
    TRUNCATED_TEXT_SUFFIX.length - suffixBudget,
  )}`;
}

function truncateJsonTextForOtelAttribute(
  value: string,
  maxChars: number,
  whole: WholeStringRedactions,
): string {
  const { text, clipped } = redactExportPrefix(value, maxChars, whole);
  return clipped || text.length > maxChars ? clipJsonText(text, maxChars) : text;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
