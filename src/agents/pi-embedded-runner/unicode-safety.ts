import type { AgentMessage } from "@mariozechner/pi-agent-core";

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const REPLACEMENT_CHAR = "\uFFFD";

type StringSanitizeResult = {
  value: string;
  replacements: number;
};

type DeepSanitizeResult<T> = {
  value: T;
  replacements: number;
  changed: boolean;
};

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= HIGH_SURROGATE_MIN && codeUnit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= LOW_SURROGATE_MIN && codeUnit <= LOW_SURROGATE_MAX;
}

function sanitizeStringInternal(input: string): StringSanitizeResult {
  if (!input) {
    return { value: input, replacements: 0 };
  }

  const parts: string[] = [];
  let replacements = 0;

  for (let i = 0; i < input.length; i++) {
    const current = input.charCodeAt(i);
    if (isHighSurrogate(current)) {
      if (i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);
        if (isLowSurrogate(next)) {
          parts.push(input[i], input[i + 1]);
          i += 1;
          continue;
        }
      }
      replacements += 1;
      parts.push(REPLACEMENT_CHAR);
      continue;
    }
    if (isLowSurrogate(current)) {
      replacements += 1;
      parts.push(REPLACEMENT_CHAR);
      continue;
    }
    parts.push(input[i]);
  }

  if (replacements === 0) {
    return { value: input, replacements: 0 };
  }
  return { value: parts.join(""), replacements };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeUnknownStringsDeepInternal(
  value: unknown,
  seen: WeakSet<object>,
): DeepSanitizeResult<unknown> {
  if (typeof value === "string") {
    const sanitized = sanitizeStringInternal(value);
    return {
      value: sanitized.value,
      replacements: sanitized.replacements,
      changed: sanitized.replacements > 0,
    };
  }

  if (Array.isArray(value)) {
    let replacements = 0;
    let changed = false;
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = sanitizeUnknownStringsDeepInternal(value[i], seen);
      replacements += next.replacements;
      if (next.changed) {
        changed = true;
        if (!out) {
          out = value.slice();
        }
        out[i] = next.value;
      }
    }
    return {
      value: changed ? (out as unknown) : value,
      replacements,
      changed,
    };
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      return { value, replacements: 0, changed: false };
    }
    seen.add(value);

    let replacements = 0;
    let changed = false;
    let out: Record<string, unknown> | undefined;
    for (const [key, child] of Object.entries(value)) {
      const next = sanitizeUnknownStringsDeepInternal(child, seen);
      replacements += next.replacements;
      if (next.changed) {
        changed = true;
        if (!out) {
          out = { ...value };
        }
        out[key] = next.value;
      }
    }
    return {
      value: changed ? (out as unknown) : value,
      replacements,
      changed,
    };
  }

  return { value, replacements: 0, changed: false };
}

export function hasUnpairedSurrogates(input: string): boolean {
  if (!input) {
    return false;
  }
  for (let i = 0; i < input.length; i++) {
    const current = input.charCodeAt(i);
    if (isHighSurrogate(current)) {
      if (i + 1 >= input.length) {
        return true;
      }
      const next = input.charCodeAt(i + 1);
      if (!isLowSurrogate(next)) {
        return true;
      }
      i += 1;
      continue;
    }
    if (isLowSurrogate(current)) {
      return true;
    }
  }
  return false;
}

export function sanitizeUnpairedSurrogates(input: string): string {
  return sanitizeStringInternal(input).value;
}

export function sanitizeUnpairedSurrogatesWithStats(input: string): StringSanitizeResult {
  return sanitizeStringInternal(input);
}

export function sanitizeUnknownStringsDeep<T>(value: T): { value: T; replacements: number } {
  const result = sanitizeUnknownStringsDeepInternal(value, new WeakSet<object>());
  return {
    value: result.value as T,
    replacements: result.replacements,
  };
}

export function sanitizeAgentMessagesUnicode(messages: AgentMessage[]): {
  messages: AgentMessage[];
  replacementCount: number;
} {
  const result = sanitizeUnknownStringsDeep(messages);
  return {
    messages: result.value,
    replacementCount: result.replacements,
  };
}
