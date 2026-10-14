import { getAiTransportHost } from "@openclaw/ai";
import {
  independentResponsesRequest,
  responsesRequestLifecycle,
} from "@openclaw/ai/internal/openai";
import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import { isCredentialFieldName } from "@openclaw/ai/internal/shared";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withGuardedFetchRequestAuthority } from "../../infra/net/fetch-request-authority.js";
import type { Message, Model } from "../../llm/types.js";
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
type SessionForkAuthority = { active: boolean; capture: object };
type Snapshot = EmbeddedSessionForkIdentity & {
  model: Model;
  context: Parameters<StreamFn>[1];
  publishedMessageStart: number;
  options: StreamOptions;
  streamFn: StreamFn;
  payload: string;
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
let retainedBytes = 0;

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

function safeHeaders(headers: Record<string, string> | undefined) {
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
    const completed = structuredClone(message);
    const bytes = Buffer.byteLength(JSON.stringify(completed));
    snapshot.context.messages.push(completed);
    snapshot.bytes += bytes;
    retainedBytes += bytes;
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
  return (model, context, options) => {
    // A transport without a payload boundary must not leave the previous turn replayable.
    forgetSnapshot(identity.sessionId);
    if (!captures.has(identity.sessionId) && captures.size >= MAX_ENTRIES) {
      const oldest = captures.keys().next().value;
      if (oldest !== undefined) {
        clearEmbeddedSessionForkSnapshot(oldest);
      }
    }
    const capture = {};
    const authority = captures.get(identity.sessionId) ?? { active: true, capture };
    authority.capture = capture;
    captures.set(identity.sessionId, authority);
    const {
      apiKey: _apiKey,
      signal: _signal,
      onPayload,
      onResponse: _onResponse,
      onActiveResponse: _onActiveResponse,
      headers,
      ...requestOptions
    } = options ?? {};
    // Clone before the stream starts: an agent may append a partial assistant while it runs.
    const savedContext = structuredClone({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      // AgentTool objects also carry executors. Retain only the transport's Tool contract.
      tools: context.tools?.map(({ name, description, parameters, async }) => ({
        name,
        description,
        parameters,
        ...(async === false ? { async } : {}),
      })),
    });
    const savedModel = structuredClone({ ...model, headers: safeHeaders(model.headers) });
    const savedOptions = { ...requestOptions, headers: safeHeaders(headers) };
    // Internal symbol carriers belong to the parent run, not the independent request.
    for (const key of Object.getOwnPropertySymbols(savedOptions)) {
      Reflect.deleteProperty(savedOptions, key);
    }
    for (const key of Object.keys(savedOptions)) {
      if (typeof Reflect.get(savedOptions, key) === "function") {
        Reflect.deleteProperty(savedOptions, key);
      }
    }
    return streamFn(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await onPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        if (isRecord(finalPayload) && authority.active && authority.capture === capture) {
          // Retain wire data once; only forks need a mutable decoded request.
          const savedPayload = JSON.stringify(finalPayload);
          const bytes =
            Buffer.byteLength(savedPayload) +
            Buffer.byteLength(
              JSON.stringify({ context: savedContext, model: savedModel, options: savedOptions }),
            ) +
            11; // ,"payload": within the accounted envelope
          forgetSnapshot(identity.sessionId);
          if (bytes <= MAX_BYTES) {
            snapshots.set(identity.sessionId, {
              ...identity,
              model: savedModel,
              context: savedContext,
              publishedMessageStart: savedContext.messages.length,
              options: savedOptions,
              payload: savedPayload,
              streamFn,
              authority,
              bytes,
              expires: Date.now() + TTL_MS,
              // Expiry owns only the session ID, never the completed turn or its async context.
              expiryTimer: getAiTransportHost().runInDetachedAsyncContext(() =>
                setTimeout(clearEmbeddedSessionForkSnapshot, TTL_MS, identity.sessionId).unref(),
              ),
            });
            retainedBytes += bytes;
          } else {
            clearEmbeddedSessionForkSnapshot(identity.sessionId);
          }
          prune();
        }
        return finalPayload;
      },
    });
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
  switch (params.model.api) {
    case "openai-responses":
    case "openai-chatgpt-responses":
    case "openai-completions":
    case "anthropic-messages":
      break;
    default:
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
  if (
    snapshot.agentId !== params.agentId ||
    snapshot.model.provider !== params.model.provider ||
    snapshot.model.id !== params.model.id ||
    snapshot.model.api !== params.model.api ||
    snapshot.model.baseUrl !== params.model.baseUrl
  ) {
    throw new Error(
      "Cache-parity session fork requires the parent's prepared model. Send a normal message first.",
    );
  }
  const context = structuredClone(snapshot.context);
  // Only publications after the prepared request can still be in flight. Pair them
  // before provider replay repair can mistake a missing result for an aborted call.
  // These placeholders belong to this fork, never the parent's retained history.
  const completedCalls = new Set<string>();
  for (let index = context.messages.length - 1; index >= snapshot.publishedMessageStart; index--) {
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
    ...snapshot.model,
    headers: params.model.headers,
  });
  const usage = createUsageAccumulator();
  for (let iteration = 0; iteration < 3; iteration++) {
    assertCurrent();
    const options: StreamOptions = {
      ...snapshot.options,
      apiKey: params.apiKey,
      signal: params.signal,
      // Background reviews cannot advertise an asynchronous tool execution capability.
      asyncToolExecution: false,
      onPayload: (payload) => {
        assertCurrent();
        const parentPayload: unknown = JSON.parse(snapshot.payload);
        if (!isRecord(payload) || !isRecord(parentPayload)) {
          throw new Error("Cache-parity session fork requires an object provider request.");
        }
        const key = Array.isArray(parentPayload.input) ? "input" : "messages";
        const prefix = parentPayload[key];
        const messages = payload[key];
        if (
          !Array.isArray(prefix) ||
          !Array.isArray(messages) ||
          messages.length <= prefix.length
        ) {
          throw new Error(
            "Cache-parity session fork could not preserve the parent request prefix.",
          );
        }
        // Rebuilding the post-hook prefix would move Anthropic's final cache breakpoint.
        const replay = {
          ...parentPayload,
          [key]: [...prefix, ...messages.slice(prefix.length).map(stripNewCacheMarkers)],
        };
        delete replay.previous_response_id;
        if (Array.isArray(replay.tools) && replay.tools.length > 0) {
          // Keep schemas/cache breakpoints, but prevent provider-hosted execution.
          // Anthropic invalidates its messages cache when tool_choice changes.
          if (model.api === "anthropic-messages") {
            replay.tool_choice = { type: "none" };
          } else if (
            model.api === "openai-responses" ||
            model.api === "openai-chatgpt-responses" ||
            model.api === "openai-completions"
          ) {
            replay.tool_choice = "none";
          } else {
            throw new Error("Session fork cannot disable hosted tools for this provider API.");
          }
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
