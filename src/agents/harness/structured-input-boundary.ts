import { truncateUtf16Safe } from "../../utils.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-types.js";

type StructuredInputScalar = string | number | boolean | null;
export type StructuredInputValue =
  | StructuredInputScalar
  | StructuredInputValue[]
  | StructuredInputRecord;
export type StructuredInputRecord = { [key: string]: StructuredInputValue };
export type StructuredInputAnswerValue = string | number | boolean | string[];

type StructuredInputDecodeResult =
  | { kind: "absent" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; entries: Array<[string, StructuredInputAnswerValue]> };

export type StructuredInputField = {
  question: AgentHarnessUserInputQuestion;
  decode: (values: readonly string[]) => StructuredInputDecodeResult;
};

type StructuredInputPlan =
  | { kind: "form"; intro: string; fields: StructuredInputField[] }
  | { kind: "url"; question: AgentHarnessUserInputQuestion };

export type StructuredInputCompileResult =
  | { kind: "ready"; plan: StructuredInputPlan }
  | { kind: "unsupported"; message: string };

/** The existing MCP view owner supplies and retires this capability with the elicitation. */
export type StructuredInputResourceContext = {
  viewId: string;
  uploads: boolean;
  previews: boolean;
  /** Checks resources admitted by this exact pending form, never arbitrary URI syntax. */
  isUploadedResource: (questionId: string, uri: string) => boolean;
};

export type StructuredInputCompilerOptions = {
  protocolName: string;
  allowEmptyForm?: boolean;
  minimumChoiceCount?: 1 | 2;
  allowEnumNames?: boolean;
  allowImagePicker?: boolean;
  /** OpenAI rich forms, including suggestions, thumbnails, and resource choices. */
  allowRichForms?: boolean;
  resourceContext?: StructuredInputResourceContext;
  booleanLabels?: readonly [string, string];
  metadata?: {
    secretPath?: readonly string[];
    otherAnswerPath?: readonly string[];
    otherQuestionIdPath?: readonly string[];
  };
};

const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 256;
const MAX_SNAPSHOT_OBJECT_KEYS = 32;
const MAX_SNAPSHOT_ARRAY_ITEMS = 16;
export const STRUCTURED_INPUT_MAX_TEXT_CHARS = 65_536;
const MAX_FIELD_NAME = 256;

/** Copies only bounded, enumerable own data properties without invoking accessors. */
export function snapshotStructuredInput(
  value: unknown,
  options?: { richForm?: boolean },
): StructuredInputValue | undefined {
  // Resource preview targets contain nested tool arguments below the resource metadata.
  // Only negotiated rich forms get this bound; ordinary/native questions retain theirs.
  const maximumDepth = options?.richForm ? 16 : MAX_SNAPSHOT_DEPTH;
  const maximumNodes = options?.richForm ? 2048 : MAX_SNAPSHOT_NODES;
  const maximumItems = options?.richForm ? 64 : MAX_SNAPSHOT_ARRAY_ITEMS;
  let nodes = 0;
  let textLength = 0;
  const visit = (current: unknown, depth: number): StructuredInputValue | undefined => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) {
      return undefined;
    }
    if (current === null || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : undefined;
    }
    if (typeof current === "string") {
      textLength += current.length;
      return current.length <= STRUCTURED_INPUT_MAX_TEXT_CHARS && textLength <= 4 * 1024 * 1024
        ? current
        : undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || current.length > maximumItems) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)),
        )
      ) {
        return undefined;
      }
      const result: StructuredInputValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return undefined;
        }
        const item = visit(descriptor.value, depth + 1);
        if (item === undefined) {
          return undefined;
        }
        result.push(item);
      }
      return result;
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length > MAX_SNAPSHOT_OBJECT_KEYS ||
      keys.some((key) => typeof key !== "string" || key.length > MAX_FIELD_NAME)
    ) {
      return undefined;
    }
    const result: StructuredInputRecord = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") {
        return undefined;
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      if (descriptor.value === undefined) {
        continue;
      }
      const item = visit(descriptor.value, depth + 1);
      if (item === undefined) {
        return undefined;
      }
      result[key] = item;
    }
    return result;
  };
  return visit(value, 0);
}

export function isStructuredInputRecord(value: unknown): value is StructuredInputRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function structuredInputEntries(
  record: StructuredInputRecord,
  maximum: number,
): Array<[string, StructuredInputValue]> | undefined {
  const entries = Object.entries(record);
  return entries.length <= maximum ? entries : undefined;
}

export function structuredInputValue(
  record: StructuredInputRecord,
  key: string,
): StructuredInputValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function structuredInputString(
  record: StructuredInputRecord,
  key: string,
): string | undefined {
  const value = structuredInputValue(record, key);
  return typeof value === "string" ? value : undefined;
}

export function structuredInputRecord(
  record: StructuredInputRecord,
  key: string,
): StructuredInputRecord | undefined {
  const value = structuredInputValue(record, key);
  return isStructuredInputRecord(value) ? value : undefined;
}

export function structuredInputArray(
  record: StructuredInputRecord,
  key: string,
  maximum: number,
): StructuredInputValue[] | undefined {
  const value = structuredInputValue(record, key);
  return Array.isArray(value) && value.length <= maximum ? value : undefined;
}

export function structuredInputFiniteNumber(
  record: StructuredInputRecord,
  key: string,
): number | null | undefined {
  const value = structuredInputValue(record, key);
  if (value === undefined || value === null) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function structuredInputInteger(
  record: StructuredInputRecord,
  key: string,
  minimum: number,
): number | null | undefined {
  const value = structuredInputFiniteNumber(record, key);
  if (value === undefined || value === null) {
    return value;
  }
  return Number.isInteger(value) && value >= minimum ? value : null;
}

export function readStructuredInputText(
  value: unknown,
  maximum: number,
  multiline = false,
): string | undefined {
  if (typeof value !== "string" || value.length > maximum) {
    return undefined;
  }
  // Ignore only paragraph whitespace for display validation; preserve the original text.
  const visibleText = multiline ? value.replace(/[\t\n\r]/gu, "") : value;
  return hasUnsafeVisibleCharacters(visibleText) ? undefined : value;
}

export function hasUnsafeVisibleCharacters(value: string): boolean {
  return /[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);
}

export function boundStructuredInputText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${truncateUtf16Safe(value, maximum - 1)}…`;
}

export function quoteStructuredInputValue(value: unknown): string {
  return JSON.stringify(value ?? "unknown");
}
