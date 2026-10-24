import { deserialize, serialize } from "node:v8";
import { getAiTransportHost } from "@openclaw/ai";
import {
  independentResponsesRequest,
  modelRequestBodyState,
  responsesRequestLifecycle,
} from "@openclaw/ai/internal/openai";
import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import { isCredentialFieldName, preparedRequestSuffix } from "@openclaw/ai/internal/shared";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import type { Message, Model, ModelRequestHeaders } from "../../llm/types.js";
import { isPlainData } from "../../shared/immutable-data.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import type { StreamFn } from "../runtime/index.js";
import { normalizeUsage, type NormalizedUsage } from "../usage.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;
export type EmbeddedSessionForkIdentity = { sessionId: string; agentId: string; runId: string };
type SessionForkAuthority = { active: boolean; capture: object; bytes: number };
type RetainedData<T> = { data: Buffer | Promise<T>; bytes: number };
type Snapshot = EmbeddedSessionForkIdentity & {
  metadata: Buffer;
  options: RetainedData<StreamOptions>;
  publications: RetainedData<Message>[];
  streamFn: StreamFn;
  payload: Blob;
  expires: number;
  bytes: number;
  expiryTimer: NodeJS.Timeout;
  authority: SessionForkAuthority;
};

const snapshots = new Map<string, Snapshot>();
const TTL_MS = 90 * 60 * 1000;
const MAX_ENTRIES = 1000;
// Parent calls replace request data, not the session authority held by an in-flight fork.
const captures = new Map<string, SessionForkAuthority>();
const MAX_BYTES = 64 * 1024 * 1024;
// Map slots, timer, Blob and snapshot wrappers on Node 26.
// Variable data/backing stores are charged separately, including pooled buffers.
const ENTRY_OVERHEAD_BYTES = 2048;
let retainedBytes = 0;

function retainData<T extends object>(value: T): RetainedData<T> {
  if (isPlainData(value)) {
    const data = serialize(value);
    return { data, bytes: 128 + retainedDataBytes(data) };
  }
  const detached = structuredClone(value);
  const bytes = 256 + retainedDataBytes(detached);
  return {
    data: getAiTransportHost().runInDetachedAsyncContext(() =>
      detachBlobStorage(detached).then(() => detached),
    ),
    bytes,
  };
}

async function readData<T>(value: RetainedData<T>): Promise<T> {
  const data = await value.data;
  return Buffer.isBuffer(data) ? deserialize(data) : structuredClone(data);
}

/** Blob slices share their entire source backing store; retain only visible bytes. */
async function detachBlobStorage(root: object): Promise<void> {
  const seen = new Map<object, unknown>();
  const visit = async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (value instanceof Blob) {
      const copy = value.arrayBuffer().then((bytes) => new Blob([bytes], { type: value.type }));
      seen.set(value, copy);
      return copy;
    }
    seen.set(value, value);
    if (value instanceof Map) {
      const entries = [];
      for (const [key, child] of value) {
        entries.push([await visit(key), await visit(child)] as const);
      }
      value.clear();
      for (const [key, child] of entries) {
        value.set(key, child);
      }
    } else if (value instanceof Set) {
      const entries = [];
      for (const child of value) {
        entries.push(await visit(child));
      }
      value.clear();
      for (const child of entries) {
        value.add(child);
      }
    } else if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
      for (const key of value instanceof Error
        ? Object.hasOwn(value, "cause")
          ? ["cause"]
          : []
        : Object.keys(value)) {
        Reflect.set(value, key, await visit(Reflect.get(value, key)));
      }
    }
    return value;
  };
  await visit(root);
}

function retireFailedData(snapshot: Snapshot, retained: RetainedData<object>): void {
  if (!Buffer.isBuffer(retained.data)) {
    void retained.data.catch(() => {
      if (snapshots.get(snapshot.sessionId) === snapshot) {
        clearEmbeddedSessionForkSnapshot(snapshot.sessionId);
      }
    });
  }
}

/** Charge our detached data, never the parent graph or shared transport runtime. */
function retainedDataBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") {
    return 32 + value.length * 2;
  }
  if (typeof value === "bigint") {
    return 32 + value.toString(16).length;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return 8;
  }
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    return 256 + retainedDataBytes(value.buffer, seen);
  }
  if (value instanceof SharedArrayBuffer) {
    // structuredClone shares this backing store, including later growth and writes.
    throw new Error("Shared memory cannot be retained for isolated fork replay");
  }
  if (value instanceof ArrayBuffer) {
    return 128 + value.byteLength;
  }
  if (value instanceof Blob) {
    return 512 + value.size + retainedDataBytes(value.type, seen);
  }
  if (value instanceof Map || value instanceof Set) {
    let bytes = 256;
    for (const [key, child] of value.entries()) {
      bytes += 64 + retainedDataBytes(key, seen);
      if (value instanceof Map) {
        bytes += retainedDataBytes(child, seen);
      }
    }
    return bytes;
  }
  if (value instanceof Date) {
    return 128;
  }
  if (value instanceof RegExp) {
    return 256 + retainedDataBytes(value.source, seen);
  }
  if (value instanceof Error) {
    return (
      256 +
      retainedDataBytes(value.message, seen) +
      retainedDataBytes(value.stack, seen) +
      retainedDataBytes(value.cause, seen)
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
    throw new Error("Unsupported retained fork data");
  }
  let bytes = 128 + (Array.isArray(value) ? value.length * 8 : 0);
  for (const key of Object.keys(value)) {
    bytes += 64 + retainedDataBytes(key, seen) + retainedDataBytes(Reflect.get(value, key), seen);
  }
  return bytes;
}

function forgetSnapshot(sessionId: string): void {
  const previous = snapshots.get(sessionId);
  if (previous) {
    clearTimeout(previous.expiryTimer);
    retainedBytes -= previous.bytes;
    snapshots.delete(sessionId);
  }
}

export function clearEmbeddedSessionForkSnapshot(sessionId?: string): void {
  if (sessionId === undefined) {
    for (const id of captures.keys()) {
      clearEmbeddedSessionForkSnapshot(id);
    }
    return;
  }
  const authority = captures.get(sessionId);
  if (authority) {
    authority.active = false;
    retainedBytes -= authority.bytes;
  }
  captures.delete(sessionId);
  forgetSnapshot(sessionId);
}
registerSessionResourceCleanup(clearEmbeddedSessionForkSnapshot);

function prune() {
  const now = Date.now();
  for (const [id, snapshot] of snapshots) {
    if (snapshot.expires <= now || retainedBytes > MAX_BYTES) {
      clearEmbeddedSessionForkSnapshot(id);
    }
  }
}

function safeHeaders(headers: ModelRequestHeaders | undefined) {
  return (
    headers &&
    Object.fromEntries(Object.entries(headers).filter(([key]) => !isCredentialFieldName(key)))
  );
}

/** Record the model-visible publication, including split async calls and their outcomes. */
export function recordEmbeddedSessionForkMessage(
  sessionId: string,
  runId: string,
  message: Message,
): void {
  const snapshot = snapshots.get(sessionId);
  if (
    !snapshot ||
    snapshot.runId !== runId ||
    !snapshot.authority.active ||
    snapshot.expires <= Date.now()
  ) {
    return;
  }
  try {
    // Provider plugins can consume opaque cloneable details that V8 cannot encode.
    const completed = retainData(message);
    const bytes = completed.bytes;
    snapshot.publications.push(completed);
    snapshot.bytes += bytes;
    retainedBytes += bytes;
    retireFailedData(snapshot, completed);
    prune();
  } catch {
    // Optional replay retention must never fail a successfully completed parent message.
    clearEmbeddedSessionForkSnapshot(sessionId);
  }
}

/** Installed below host context transforms and above the actual provider transport. */
export function wrapStreamFnWithSessionFork(
  streamFn: StreamFn,
  identity: EmbeddedSessionForkIdentity,
): StreamFn {
  return async (model, context, options) => {
    // A new run or transport cannot reuse old prepared data. Within the same run,
    // keep the last committed request until its replacement finishes preparing.
    const previous = snapshots.get(identity.sessionId);
    if (previous && (previous.runId !== identity.runId || previous.streamFn !== streamFn)) {
      forgetSnapshot(identity.sessionId);
    }
    if (!captures.has(identity.sessionId) && captures.size >= MAX_ENTRIES) {
      const oldest = captures.keys().next().value;
      if (oldest !== undefined) {
        clearEmbeddedSessionForkSnapshot(oldest);
      }
    }
    const capture = {};
    let authority = captures.get(identity.sessionId);
    if (!authority) {
      authority = { active: true, capture, bytes: 256 + retainedDataBytes(identity.sessionId) };
      captures.set(identity.sessionId, authority);
      retainedBytes += authority.bytes;
      prune();
    }
    authority.capture = capture;
    const {
      apiKey: _apiKey,
      signal: _signal,
      onPayload,
      onResponse: _onResponse,
      onActiveResponse: _onActiveResponse,
      ...savedOptions
    } = options ?? {};
    savedOptions.headers = safeHeaders(savedOptions.headers);
    // Internal symbol carriers belong to the parent run, not the independent request.
    for (const key of Object.getOwnPropertySymbols(savedOptions)) {
      Reflect.deleteProperty(savedOptions, key);
    }
    for (const key of Object.keys(savedOptions)) {
      if (typeof Reflect.get(savedOptions, key) === "function") {
        Reflect.deleteProperty(savedOptions, key);
      }
    }
    let retainedOptions: RetainedData<StreamOptions> | undefined;
    try {
      retainedOptions = retainData(savedOptions);
      if (!Buffer.isBuffer(retainedOptions.data)) {
        await retainedOptions.data;
      }
    } catch {
      // Finish optional copies before provider preparation can publish a replacement prefix.
      retainedOptions = undefined;
    }
    const save = (savedPayload: Blob) => {
      if (!retainedOptions || !authority.active || authority.capture !== capture) {
        return;
      }
      // Only tool metadata is needed to convert the suffix; the prefix is already on the wire.
      let metadata: Buffer;
      let bytes: number;
      try {
        const json = JSON.stringify({
          model: { ...model, headers: safeHeaders(model.headers) },
          tools: context.tools?.map(({ name, description, parameters, async }) => ({
            name,
            description,
            parameters,
            ...(async === false ? { async } : {}),
          })),
        });
        // A small pooled Buffer can pin a whole slab shared with unrelated requests.
        metadata = Buffer.allocUnsafeSlow(Buffer.byteLength(json));
        metadata.write(json);
        bytes =
          ENTRY_OVERHEAD_BYTES +
          savedPayload.size +
          retainedDataBytes(metadata) +
          retainedOptions.bytes +
          retainedDataBytes(identity.sessionId) +
          retainedDataBytes(identity.agentId) +
          retainedDataBytes(identity.runId);
      } catch {
        // Optional capture must not fail the parent or revoke already-running forks.
        return;
      }
      forgetSnapshot(identity.sessionId);
      if (bytes <= MAX_BYTES) {
        const snapshot: Snapshot = {
          ...identity,
          metadata,
          options: retainedOptions,
          publications: [],
          payload: savedPayload,
          streamFn,
          authority,
          bytes,
          expires: Date.now() + TTL_MS,
          expiryTimer: getAiTransportHost().runInDetachedAsyncContext(() =>
            setTimeout(clearEmbeddedSessionForkSnapshot, TTL_MS, identity.sessionId).unref(),
          ),
        };
        snapshots.set(identity.sessionId, snapshot);
        retainedBytes += bytes;
      } else {
        clearEmbeddedSessionForkSnapshot(identity.sessionId);
      }
      prune();
    };
    let preparedPayload: unknown;
    const capturedOptions: StreamOptions = {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await onPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        // Native ChatGPT, Anthropic, and custom transports do not use the encoded-body boundary.
        if (modelRequestBodyState(capturedOptions).enabled) {
          preparedPayload = finalPayload;
        } else if (isRecord(finalPayload)) {
          save(new Blob([JSON.stringify(finalPayload)]));
        }
        return finalPayload;
      },
    };
    modelRequestBodyState(capturedOptions).onEncoded = (body, payload) => {
      if (!isRecord(payload)) {
        return;
      }
      // HTTP continuations send only a suffix; an independent fork still needs the full prefix.
      // Suffix-only retries reuse the captured prefix; a rebuilt request calls onPayload again.
      if (payload.previous_response_id && preparedPayload === undefined) {
        return;
      }
      save(payload.previous_response_id ? new Blob([JSON.stringify(preparedPayload)]) : body);
      preparedPayload = undefined;
    };
    return streamFn(model, context, capturedOptions);
  };
}

const EMBEDDED_FORK_REQUIRES_PARENT =
  "Cache-parity session fork requires a parent turn prepared by this OpenClaw runtime. Send a normal message first.";

function stripNewCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNewCacheMarkers);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, child]) => [key, stripNewCacheMarkers(child)]),
  );
}

const FORK_TOOL_CHOICE_SHAPES = new Map<Model["api"], "object" | "string">([
  ["anthropic-messages", "object"],
  ["openai-responses", "string"],
  ["openai-chatgpt-responses", "string"],
  ["openai-completions", "string"],
]);

/** Replay prepared payload data, never the parent's one-shot admission hooks or tool executor. */
export async function runEmbeddedSessionFork(params: {
  sessionId: string;
  agentId: string;
  question: string;
  model: Model;
  apiKey?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onUsage?: (usage: NormalizedUsage | undefined) => void;
}): Promise<string> {
  if (!FORK_TOOL_CHOICE_SHAPES.has(params.model.api)) {
    throw new Error(
      `Session forks do not support provider API ${params.model.api}. Use OpenAI Responses, Chat Completions, or Anthropic Messages.`,
    );
  }
  prune();
  const snapshot = snapshots.get(params.sessionId);
  if (!snapshot) {
    throw new Error(EMBEDDED_FORK_REQUIRES_PARENT);
  }
  const assertCurrent = () => {
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (!snapshot.authority.active || snapshot.expires <= Date.now()) {
      throw new Error(EMBEDDED_FORK_REQUIRES_PARENT);
    }
  };
  assertCurrent();
  const metadata: {
    model: Model;
    tools: Parameters<StreamFn>[1]["tools"];
  } = JSON.parse(snapshot.metadata.toString("utf8"));
  if (
    snapshot.agentId !== params.agentId ||
    metadata.model.provider !== params.model.provider ||
    metadata.model.id !== params.model.id ||
    metadata.model.api !== params.model.api ||
    metadata.model.baseUrl !== params.model.baseUrl
  ) {
    throw new Error(
      "Cache-parity session fork requires the parent's prepared model. Send a normal message first.",
    );
  }
  const context: Parameters<StreamFn>[1] = {
    tools: metadata.tools,
    messages: await Promise.all(snapshot.publications.map((data) => readData(data))),
  };
  const parentPayload: unknown = JSON.parse(await snapshot.payload.text());
  if (!isRecord(parentPayload)) {
    throw new Error("Cache-parity session fork requires an object provider request.");
  }
  const key = Array.isArray(parentPayload.input) ? "input" : "messages";
  const prefix = parentPayload[key];
  if (!Array.isArray(prefix)) {
    throw new Error("Cache-parity session fork could not preserve the parent request prefix.");
  }
  const toolCallIds = new Set<string>();
  for (const message of prefix) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.type === "function_call" && typeof message.call_id === "string") {
      toolCallIds.add(message.call_id);
    }
    const blocks = message.tool_calls ?? message.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (
          isRecord(block) &&
          (block.type === "tool_use" || block.type === "function") &&
          typeof block.id === "string"
        ) {
          toolCallIds.add(block.id);
        }
      }
    }
  }
  preparedRequestSuffix.mark(context, toolCallIds);
  // Only publications after the prepared request can still be in flight. Pair them
  // before provider replay repair can mistake a missing result for an aborted call.
  // These placeholders belong to this fork, never the parent's retained history.
  const completedCalls = new Set<string>();
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role === "toolResult") {
      completedCalls.add(message.toolCallId);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall" || completedCalls.delete(block.id)) {
          continue;
        }
        context.messages.splice(index + 1, 0, {
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [
            {
              type: "text",
              text: "This tool call is still running. Its result is not available yet.",
            },
          ],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  }
  context.messages.push({ role: "user", content: params.question, timestamp: Date.now() });
  const model = getAiTransportHost().inheritManagedTransport(params.model, {
    ...metadata.model,
    headers: params.model.headers,
  });
  const usage = createUsageAccumulator();
  for (let iteration = 0; iteration < 3; iteration++) {
    assertCurrent();
    const options: StreamOptions = {
      ...(await readData(snapshot.options)),
      apiKey: params.apiKey,
      signal: params.signal,
      // Background reviews cannot advertise an asynchronous tool execution capability.
      asyncToolExecution: false,
      onPayload: (payload) => {
        assertCurrent();
        if (!isRecord(payload)) {
          throw new Error("Cache-parity session fork requires an object provider request.");
        }
        const messages = payload[key];
        if (!Array.isArray(messages)) {
          throw new Error(
            "Cache-parity session fork could not preserve the parent request prefix.",
          );
        }
        // Rebuilding the post-hook prefix would move Anthropic's final cache breakpoint.
        const replay = {
          ...parentPayload,
          [key]: [...prefix, ...messages.map(stripNewCacheMarkers)],
        };
        delete replay.previous_response_id;
        if (Array.isArray(replay.tools) && replay.tools.length > 0) {
          // Keep schemas/cache breakpoints, but prevent provider-hosted execution.
          // Anthropic invalidates its messages cache when tool_choice changes.
          const toolChoiceShape = FORK_TOOL_CHOICE_SHAPES.get(model.api);
          if (!toolChoiceShape) {
            throw new Error("Session fork cannot disable hosted tools for this provider API.");
          }
          replay.tool_choice = toolChoiceShape === "object" ? { type: "none" } : "none";
        }
        return replay;
      },
    };
    independentResponsesRequest.set(options);
    // Native ChatGPT WebSockets and SSE use the same send-time lifecycle owner.
    responsesRequestLifecycle.set(options, {
      assertCurrent,
      beforeDispatch: async () => assertCurrent(),
      accepted: async () => assertCurrent(),
      settle: async () => assertCurrent(),
    });
    assertCurrent();
    const result = await withGuardedFetchRequestAuthority(assertCurrent, async () => {
      const stream = await snapshot.streamFn(model, context, options);
      assertCurrent();
      return await stream.result();
    });
    assertCurrent();
    mergeUsageIntoAccumulator(usage, normalizeUsage(result.usage));
    params.onUsage?.(toNormalizedUsage(usage));
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage || "Cache-parity session fork failed.");
    }
    const calls = result.content.filter((block) => block.type === "toolCall");
    if (calls.length === 0) {
      const text = collectTextContentBlocks(result.content).join("").trim();
      if (!text) {
        throw new Error("No cache-parity session fork response generated.");
      }
      return text;
    }
    context.messages.push(result);
    for (const call of calls) {
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: "Tool execution denied for this side question. Answer without calling tools.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
  throw new Error(
    "Cache-parity session fork kept requesting tools after three attempts. Ask a question that can be answered without tools.",
  );
}
