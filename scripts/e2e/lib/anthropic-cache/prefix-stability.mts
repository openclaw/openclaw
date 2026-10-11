import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export type CacheRequestApi = "openai-responses" | "openai-completions" | "anthropic-messages";
export type ProviderPrefixSnapshot = {
  system: string;
  tools: string;
  cacheKey: string;
  history: string[];
  breakpoints: Array<{ index: number; policy: string }>;
};

function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid request object",
  );
  return value as Record<string, unknown>;
}

function bytes(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function digest(value: string | undefined): string {
  return value === undefined ? "absent" : createHash("sha256").update(value).digest("hex");
}

const protocolFields = new Set([
  "role",
  "type",
  "content",
  "text",
  "output",
  "id",
  "call_id",
  "tool_call_id",
  "tool_use_id",
  "name",
  "arguments",
  "function",
  "block",
  "image_url",
  "source",
  "data",
  "url",
  "cache_control",
  "prompt_cache_key",
  "description",
]);

function firstDifference(before: unknown, after: unknown, path = "$"): string {
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
      if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) {
        return firstDifference(before[index], after[index], `${path}[${index}]`);
      }
    }
  } else if (before && after && typeof before === "object" && typeof after === "object") {
    const left = Object.entries(before);
    const right = Object.entries(after);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const previous = left[index];
      const next = right[index];
      if (previous?.[0] !== next?.[0]) {
        return firstDifference(previous?.[0], next?.[0], `${path}.keys[${index}]`);
      }
      if (previous && next && JSON.stringify(previous[1]) !== JSON.stringify(next[1])) {
        // Arbitrary schema keys can contain user data; only protocol field names are safe.
        const field = protocolFields.has(previous[0]) ? previous[0] : `fields[${index}]`;
        return firstDifference(previous[1], next[1], `${path}.${field}`);
      }
    }
  }
  const left = JSON.stringify(before);
  const right = JSON.stringify(after);
  return `path=${path} leafPrevious=${digest(left)} leafNext=${digest(right)} leafBytes=${left === undefined ? 0 : Buffer.byteLength(left)}:${right === undefined ? 0 : Buffer.byteLength(right)}`;
}

function imageCleanupBytes(serialized: string): string {
  let images = 0;
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(project);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const block = object(value);
    if (block.type === "image" || block.type === "image_url" || block.type === "input_image") {
      images += 1;
      return {
        type: block.type === "input_image" ? "input_text" : "text",
        text: "[image data removed - already processed by model]",
      };
    }
    return Object.fromEntries(Object.entries(block).map(([key, field]) => [key, project(field)]));
  };
  const expected = bytes(project(JSON.parse(serialized)));
  assert(images > 0, "image cleanup boundary must contain an image");
  return expected;
}

/** Preserve wire ordering and bytes; only movable conversation cache markers are separate. */
export function snapshotProviderPrefix(
  api: CacheRequestApi,
  payload: unknown,
): ProviderPrefixSnapshot {
  const request = object(payload);
  const history: string[] = [];
  const breakpoints: ProviderPrefixSnapshot["breakpoints"] = [];
  const messages = api === "openai-responses" ? request.input : request.messages;
  assert(Array.isArray(messages), "missing provider request history");
  for (const raw of messages) {
    const message = object(raw);
    if (api === "anthropic-messages") {
      const content =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content;
      assert(Array.isArray(content), "missing Anthropic message content");
      const { content: _content, ...envelope } = message;
      for (const rawBlock of content) {
        const { cache_control, ...block } = object(rawBlock);
        if (cache_control !== undefined) {
          breakpoints.push({ index: history.length, policy: bytes(cache_control) });
        }
        history.push(bytes({ ...envelope, block }));
      }
    } else {
      history.push(bytes(message));
    }
  }
  return {
    system: bytes(api === "openai-responses" ? request.instructions : request.system),
    tools: bytes(request.tools),
    cacheKey: bytes({
      model: request.model,
      prompt_cache_key: request.prompt_cache_key,
      prompt_cache_retention: request.prompt_cache_retention,
      prompt_cache_options: request.prompt_cache_options,
      cache_control: request.cache_control,
    }),
    history,
    breakpoints,
  };
}

/** Failure output must never disclose prompts, tool results, or images. */
export function assertStableProviderPrefix(
  previous: ProviderPrefixSnapshot,
  next: ProviderPrefixSnapshot,
  options: {
    label: string;
    historyLength?: number;
    boundary?:
      | { kind: "image-cleanup"; historyIndexes: number[] }
      | { kind: "history-pruning"; startIndex: number; deleteCount: number };
  },
): void {
  const same = (segment: string, before: string | undefined, after: string | undefined) => {
    if (before !== after) {
      throw new Error(
        `${options.label}: prefix changed segment=${segment} previous=${digest(before)} next=${digest(after)} ${firstDifference(before === undefined ? undefined : JSON.parse(before), after === undefined ? undefined : JSON.parse(after))}`,
      );
    }
  };
  for (const segment of ["system", "tools", "cacheKey"] as const) {
    same(segment, previous[segment], next[segment]);
  }
  const length = options.historyLength ?? previous.history.length;
  assert(
    Number.isInteger(length) && length >= 0 && length <= previous.history.length,
    "invalid stable history boundary",
  );
  const boundary = options.boundary;
  const changedIndexes = new Set(boundary?.kind === "image-cleanup" ? boundary.historyIndexes : []);
  let history = previous.history.slice(0, length);
  let prunedCount = 0;
  if (boundary?.kind === "history-pruning") {
    assert(
      Number.isInteger(boundary.startIndex) &&
        boundary.startIndex >= 0 &&
        Number.isInteger(boundary.deleteCount) &&
        boundary.deleteCount > 0 &&
        boundary.startIndex + boundary.deleteCount <= length,
      "invalid history pruning boundary",
    );
    history = history.toSpliced(boundary.startIndex, boundary.deleteCount);
    prunedCount = boundary.deleteCount;
  }
  for (const index of changedIndexes) {
    assert(
      Number.isInteger(index) && index >= 0 && index < length,
      "invalid image cleanup boundary",
    );
  }
  for (let index = 0; index < history.length; index++) {
    if (!changedIndexes.has(index)) {
      same(`history[${index}]`, history[index], next.history[index]);
    } else {
      same(`history[${index}]`, imageCleanupBytes(history[index]!), next.history[index]);
    }
  }
  // Anthropic moves the last breakpoint as history grows; its retention policy
  // and coverage of the old marked prefix must survive that movement.
  if (previous.breakpoints.length || next.breakpoints.length) {
    const policies = (snapshot: ProviderPrefixSnapshot) =>
      bytes([...new Set(snapshot.breakpoints.map((marker) => marker.policy))].toSorted());
    same("cacheBreakpoint.policy", policies(previous), policies(next));
  }
  const before = previous.breakpoints.at(-1);
  if (before) {
    const after = next.breakpoints.at(-1);
    same("cacheBreakpoint.policy", before.policy, after?.policy);
    if (!after || after.index < before.index - prunedCount) {
      same(
        "cacheBreakpoint.coverage",
        bytes(before.index - prunedCount),
        after && bytes(after.index),
      );
    }
  }
}
