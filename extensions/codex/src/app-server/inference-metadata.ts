import type { IncomingHttpHeaders } from "node:http";
import { asBoolean, isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { JsonObject } from "./protocol-json.js";

const MAX_NATIVE_METADATA_BYTES = 1024 * 1024;
const MAX_METADATA_FIELD_BYTES = 256;
export const CODEX_INFERENCE_GENERATION_KEY = "openclaw_inference_generation";

/** Native request facts; their consistency does not grant execution authority. */
export type CodexInferenceMetadata = Readonly<{
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  parentTurnId?: string;
  rootTurnId?: string;
  requestKind?: string;
  threadSource?: string;
  subagent?: string;
  subagentKind?: string;
  guardianClassifierSourceThreadId?: string;
  autoReviewEnabled?: boolean;
  nodeReplAutoReviewRequired?: boolean;
  generation?: string;
  nativeImageTurnId?: string;
}>;

/** Call only after authenticating the private transport that supplied these carriers. */
export function readCodexInferenceMetadata(
  body: JsonObject,
  headers?: IncomingHttpHeaders,
  transport: "http" | "websocket" = "http",
  path?: string,
): CodexInferenceMetadata {
  if (transport === "http" && (path === "/images/generations" || path === "/images/edits")) {
    // Native Images carries its real tool-call turn in this header, without Responses metadata.
    const nativeImageTurnId = readId("image turn", headers?.["x-codex-image-turn-id"]);
    if (!nativeImageTurnId) {
      throw new Error("Codex image inference has no native turn metadata");
    }
    return Object.freeze({ nativeImageTurnId });
  }
  const flat = body.client_metadata;
  if (flat !== undefined && !isRecord(flat)) {
    throw new Error("Codex inference request has invalid native metadata");
  }
  const nested = readNativeMetadata(flat?.["x-codex-turn-metadata"]);
  // HTTP headers describe this request. A reused WebSocket's handshake describes an older turn.
  const httpHeaders = transport === "http" ? headers : undefined;
  const compatibility = readNativeMetadata(httpHeaders?.["x-codex-turn-metadata"]);
  if (!nested && !compatibility) {
    throw new Error("Codex inference request is missing bounded native metadata");
  }
  const requestKind = reconcileMetadataStrings(
    "request kind",
    nested?.request_kind,
    compatibility?.request_kind,
  );
  const generation = readId(
    "parent generation",
    nested?.[CODEX_INFERENCE_GENERATION_KEY],
    compatibility?.[CODEX_INFERENCE_GENERATION_KEY],
  );
  const nativeThreadId = readId("thread", nested?.thread_id, compatibility?.thread_id);
  if (
    !nativeThreadId &&
    (requestKind === "turn" ||
      (requestKind === "prewarm" && !(body.generate === false && generation === undefined)))
  ) {
    throw new Error("Codex inference request has no native thread metadata");
  }
  return Object.freeze({
    sessionId: readId(
      "session",
      flat?.session_id,
      nested?.session_id,
      compatibility?.session_id,
      httpHeaders?.["session-id"],
    ),
    threadId: readId("thread", flat?.thread_id, nativeThreadId, httpHeaders?.["thread-id"]),
    turnId: readId("turn", flat?.turn_id, nested?.turn_id, compatibility?.turn_id),
    parentThreadId: readId(
      "parent thread",
      flat?.["x-codex-parent-thread-id"],
      nested?.parent_thread_id,
      compatibility?.parent_thread_id,
      httpHeaders?.["x-codex-parent-thread-id"],
    ),
    parentTurnId: readId(
      "parent turn",
      flat?.parent_turn_id,
      nested?.parent_turn_id,
      compatibility?.parent_turn_id,
    ),
    rootTurnId: readId(
      "root turn",
      flat?.root_turn_id,
      nested?.root_turn_id,
      compatibility?.root_turn_id,
    ),
    requestKind,
    threadSource: reconcileMetadataStrings(
      "thread source",
      nested?.thread_source,
      compatibility?.thread_source,
    ),
    // SessionSource is fixed for this native model client, including across reused WS turns.
    subagent: reconcileMetadataStrings(
      "subagent",
      flat?.["x-openai-subagent"],
      headers?.["x-openai-subagent"],
    ),
    subagentKind: reconcileMetadataStrings(
      "subagent kind",
      nested?.subagent_kind,
      compatibility?.subagent_kind,
    ),
    guardianClassifierSourceThreadId: readId(
      "Guardian classifier source thread",
      nested?.guardian_classifier_source_thread_id,
      compatibility?.guardian_classifier_source_thread_id,
    ),
    autoReviewEnabled: reconcileMetadataBooleans(
      "automatic review",
      nested?.auto_review_enabled,
      compatibility?.auto_review_enabled,
    ),
    nodeReplAutoReviewRequired: reconcileMetadataBooleans(
      "model-required review",
      nested?.node_repl_auto_review_required,
      compatibility?.node_repl_auto_review_required,
    ),
    generation,
  });
}

function readNativeMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const encoded = readStringValue(raw);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_NATIVE_METADATA_BYTES) {
    throw new Error("Codex inference request is missing bounded native metadata");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Codex inference request has invalid native metadata");
  }
  if (!isRecord(value)) {
    throw new Error("Codex inference request has invalid native metadata");
  }
  return value;
}

function reconcileMetadataStrings(field: string, ...values: unknown[]): string | undefined {
  let result: string | undefined;
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const candidate = readStringValue(value);
    if (candidate === undefined || Buffer.byteLength(candidate) > MAX_METADATA_FIELD_BYTES) {
      throw new Error(`Codex inference ${field} metadata is invalid or exceeds its limit`);
    }
    if (result !== undefined && candidate !== result) {
      throw new Error(`Codex inference ${field} metadata disagrees`);
    }
    result = candidate;
  }
  return result;
}

function readId(field: string, ...values: unknown[]): string | undefined {
  const value = reconcileMetadataStrings(field, ...values);
  if (value !== undefined && (!value || value.trim() !== value)) {
    throw new Error(`Codex inference ${field} metadata has an invalid identity`);
  }
  return value;
}

function reconcileMetadataBooleans(field: string, ...values: unknown[]): boolean | undefined {
  let result: boolean | undefined;
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const candidate = asBoolean(value);
    if (candidate === undefined) {
      throw new Error(`Codex inference ${field} metadata is invalid`);
    }
    if (result !== undefined && candidate !== result) {
      throw new Error(`Codex inference ${field} metadata disagrees`);
    }
    result = candidate;
  }
  return result;
}
