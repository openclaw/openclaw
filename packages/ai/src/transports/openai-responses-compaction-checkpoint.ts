import type { Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseCompactionItemParam,
  ResponseInputItem,
} from "openai/resources/responses/responses.js";
import type { AiTransportHost } from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesCompactionReplayState,
  type ReplayableResponseCompactionItem,
  type ReplayableResponseOutputMessage,
} from "./openai-responses-contracts.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import {
  buildProviderReplayContext,
  isProviderReplayContext,
  providerReplayContextMatches,
  type ProviderReplayContext,
} from "./provider-replay-context.js";
import { sanitizeResponsesImageInput } from "./responses-image-input-sanitizer.js";

// This is the host's response/storage ceiling, not a provider context-token limit.
export const COMPACTION_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export type OpenAIResponsesCompactionOutput = Array<
  ResponseInputItem.Message | ReplayableResponseOutputMessage | ReplayableResponseCompactionItem
>;
export type OpenAIResponsesCompactedWindow =
  | { state: "ready"; output: string; outputTokens?: number }
  | { state: "refresh-required" };

// Retain identity only, never parsed windows or their image data, alongside saved replay state.
const compactionInputIdentities = new WeakMap<object, object[]>();
const preparedCompactionInputs = new WeakMap<object, object>();

export function getResponsesCompactionInputIdentity(item: object): object | undefined {
  return preparedCompactionInputs.get(item);
}

function publishResponsesCompactionInput<T extends object[]>(
  source: object,
  input: T,
  immutable?: AiTransportHost["immutableData"],
): T {
  if (!immutable?.isDeeplyFrozenPlainData(source)) {
    return input;
  }
  let identities = compactionInputIdentities.get(source);
  if (!identities) {
    identities = [];
    compactionInputIdentities.set(source, identities);
  }
  let index = 0;
  for (const item of input) {
    immutable.freezeJsonSnapshot(item);
    preparedCompactionInputs.set(item, (identities[index++] ??= {}));
  }
  return input;
}

/** Provenance is off-wire; an alias of prepared immutable input keeps its byte identity. */
export function tagResponsesCompactionInput<T extends object>(item: T, marker: symbol): T {
  const tagged = { ...item, [marker]: true };
  const identity = preparedCompactionInputs.get(item);
  if (identity) {
    Object.freeze(tagged);
    preparedCompactionInputs.set(tagged, identity);
  }
  return tagged;
}

// Schema validation, not coercion: supplied non-string fields must be rejected.
function isOptionalCompactionString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  // Optional provider metadata reaches recursive transcript redaction. Bound
  // its nesting as well as bytes before retaining an otherwise valid window.
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return (
    (Array.isArray(value) || isRecord(value)) &&
    Object.values(value).every((child) => isBoundedJson(child, depth + 1))
  );
}

function isInputContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const breakpoint = value.prompt_cache_breakpoint;
  if (breakpoint !== undefined && (!isRecord(breakpoint) || breakpoint.mode !== "explicit")) {
    return false;
  }
  switch (value.type) {
    case "input_text":
      return typeof value.text === "string";
    case "output_text":
      return typeof value.text === "string" && Array.isArray(value.annotations);
    case "input_image":
      return (
        typeof value.detail === "string" &&
        ["auto", "low", "high", "original"].includes(value.detail) &&
        (typeof value.image_url === "string" || typeof value.file_id === "string") &&
        (value.image_url === null || isOptionalCompactionString(value.image_url)) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id))
      );
    case "input_file":
      return (
        (value.detail === undefined ||
          (typeof value.detail === "string" && ["auto", "low", "high"].includes(value.detail))) &&
        [value.file_data, value.file_id, value.file_url].some(
          (entry) => typeof entry === "string",
        ) &&
        isOptionalCompactionString(value.file_data) &&
        (value.file_id === null || isOptionalCompactionString(value.file_id)) &&
        isOptionalCompactionString(value.file_url) &&
        isOptionalCompactionString(value.filename)
      );
    default:
      return false;
  }
}

/** Validate without projecting: accepted provider fields must survive replay unchanged. */
export function isOpenAIResponsesCompactionOutput(
  value: unknown,
  model?: Model,
): value is OpenAIResponsesCompactionOutput {
  return getOpenAIResponsesCompactionOutputError(value, model) === undefined;
}

/** Return a safe rule failure, never provider content or encrypted checkpoint bytes. */
export function getOpenAIResponsesCompactionOutputError(
  value: unknown,
  model?: Model,
): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return "output must be a nonempty array";
  }
  if (!isBoundedJson(value)) {
    return "output must contain finite JSON values nested at most 64 levels";
  }
  const item: unknown = value.at(-1);
  if (!isRecord(item) || item.type !== "compaction") {
    return "output must end with a compaction item";
  }
  if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    return "trailing compaction item must have nonempty encrypted_content";
  }
  if (!isOptionalCompactionString(item.id) || !isOptionalCompactionString(item.created_by)) {
    return "trailing compaction item metadata must be strings";
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    const message: unknown = value[index];
    if (isRecord(message) && message.type === "compaction") {
      return "output must contain exactly one compaction item";
    }
    if (
      !isRecord(message) ||
      message.type !== "message" ||
      typeof message.role !== "string" ||
      !["user", "developer", "system", "assistant"].includes(message.role)
    ) {
      return `output item ${index} must be a user, developer, system, or assistant message`;
    }
    if (
      !isOptionalCompactionString(message.id) ||
      (message.status !== undefined &&
        (typeof message.status !== "string" ||
          !["in_progress", "completed", "incomplete"].includes(message.status)))
    ) {
      return `output message ${index} has invalid metadata`;
    }
    if (!Array.isArray(message.content) || !message.content.every(isInputContent)) {
      return `output message ${index} has unsupported content`;
    }
  }
  // Storage accepts some image formats that Responses egress would replace.
  // A canonical window must survive that existing policy without any rewrite.
  const payload = { input: sanitizeResponsesImageInput(value) };
  if (model) {
    applyOpenAIResponsesPayloadPolicy(payload, resolveOpenAIResponsesPayloadPolicy(model));
  }
  if (JSON.stringify(payload.input) !== JSON.stringify(value)) {
    return "output would be rewritten by the Responses payload policy";
  }
  return undefined;
}

/** Remaining storage allowance for replay metadata rewrites, without retaining checkpoint bytes. */
export function getOpenAIResponsesCompactionWindowReplayBytesAvailable(replay: unknown): number {
  return COMPACTION_WINDOW_MAX_BYTES - Buffer.byteLength(JSON.stringify(replay), "utf8");
}

/** Read the saved canonical window only when it still matches its opaque checkpoint. */
export function readOpenAIResponsesCompactionWindow(
  replay: {
    data: string;
    id?: string;
    compactedWindow?: unknown;
  },
  model?: Model,
  immutable?: AiTransportHost["immutableData"],
): OpenAIResponsesCompactionOutput | undefined {
  const window = replay.compactedWindow;
  if (!isRecord(window) || window.state !== "ready" || typeof window.output !== "string") {
    return undefined;
  }
  if (
    window.outputTokens !== undefined &&
    (!Number.isSafeInteger(window.outputTokens) ||
      typeof window.outputTokens !== "number" ||
      window.outputTokens < 0)
  ) {
    return undefined;
  }
  if (
    Buffer.byteLength(window.output, "utf8") + Buffer.byteLength(replay.data, "utf8") >
    COMPACTION_WINDOW_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    if (getOpenAIResponsesCompactionWindowReplayBytesAvailable(replay) < 0) {
      return undefined;
    }
    const output: unknown = JSON.parse(window.output);
    if (!isOpenAIResponsesCompactionOutput(output, model)) {
      return undefined;
    }
    const item = output.at(-1);
    if (
      item?.type !== "compaction" ||
      item.encrypted_content !== replay.data ||
      item.id !== replay.id
    ) {
      return undefined;
    }
    // These IDs refer to reasoning items absorbed by the checkpoint. Replaying
    // them makes OpenAI require those missing items; keep the saved window intact
    // but emit retained assistants as inline messages, with content and phase unchanged.
    for (const message of output) {
      if (message.type === "message" && message.role === "assistant") {
        delete message.id;
      }
    }
    return publishResponsesCompactionInput(replay, output, immutable);
  } catch {
    return undefined;
  }
}

export const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE =
  "openai-responses-compaction-suppression";
export const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA = "rejected";
type OpenAIResponsesCompactionSuppressionState = ProviderReplayState & {
  type: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE;
  data: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA;
  baseUrlHash: string;
  itemRecovery?: string;
};

function isOpenAIResponsesCompactionState(
  state: ProviderReplayContext & Record<string, unknown>,
): state is Record<string, unknown> &
  (OpenAIResponsesCompactionReplayState | OpenAIResponsesCompactionSuppressionState) {
  if (typeof state.baseUrlHash !== "string" || state.v !== 1) {
    return false;
  }
  if (state.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE) {
    return state.data === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA;
  }
  const retained = state.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE;
  return (
    (retained || state.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE) &&
    typeof state.data === "string" &&
    state.data.length > 0 &&
    (state.id === undefined || typeof state.id === "string") &&
    (state.replayIndex === undefined ||
      (!retained &&
        typeof state.replayIndex === "number" &&
        Number.isSafeInteger(state.replayIndex) &&
        state.replayIndex >= 0))
  );
}

export function readOpenAIResponsesCompactionReplayState(
  value: unknown,
): OpenAIResponsesCompactionReplayState | OpenAIResponsesCompactionSuppressionState | undefined {
  return isRecord(value) &&
    isProviderReplayContext(value) &&
    isOpenAIResponsesCompactionState(value)
    ? value
    : undefined;
}

export function readOpenAIResponsesItemRecoveryAnchor(
  replay: ProviderReplayState | undefined,
): string | undefined {
  const state = readOpenAIResponsesCompactionReplayState(replay);
  return state?.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE &&
    typeof state.itemRecovery === "string"
    ? state.itemRecovery
    : undefined;
}

export function isSafeResponsesReplayItemId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH
  );
}

export type OpenAIResponsesCompactionSource =
  | {
      item: ResponseCompactionItemParam;
      mode: "compacted-prefix";
      replayIndex: number;
    }
  | {
      item: ResponseCompactionItemParam;
      mode: "complete-window";
      output: OpenAIResponsesCompactionOutput;
      outputTokens?: number;
      replayIndex: number;
    }
  | { mode: "refresh-required" }
  | { mode: "item-recovery"; anchor: string };

/** Read one live replay envelope; null blocks older checkpoints, undefined skips it. */
export function createOpenAIResponsesCompactionSourceReader(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "sessionId">,
  resolveImmutableData?: () => AiTransportHost["immutableData"],
) {
  const context = buildProviderReplayContext(model, options);
  return (
    value: ProviderReplayState | undefined,
    contentLength: number,
  ): OpenAIResponsesCompactionSource | null | undefined => {
    const replay = readOpenAIResponsesCompactionReplayState(value);
    if (replay?.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE) {
      // Item repair belongs to copied history, including internal-session forks;
      // encrypted checkpoints and ordinary suppression remain session-bound.
      if (
        providerReplayContextMatches(
          replay,
          typeof replay.itemRecovery === "string"
            ? { ...context, sessionHash: replay.sessionHash }
            : context,
        )
      ) {
        return typeof replay.itemRecovery === "string"
          ? { mode: "item-recovery", anchor: replay.itemRecovery }
          : null;
      }
      return undefined;
    }
    if (
      replay?.type !== OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
      replay?.type !== OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
    ) {
      return value?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE ||
        value?.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
        ? null
        : undefined;
    }
    if (!providerReplayContextMatches(replay, context)) {
      return null;
    }
    if (
      replay.compactedWindow !== undefined ||
      replay.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
    ) {
      const output = readOpenAIResponsesCompactionWindow(replay, model, resolveImmutableData?.());
      const item = output?.at(-1);
      if (!output || item?.type !== "compaction") {
        return { mode: "refresh-required" };
      }
      return {
        mode: "complete-window",
        output,
        ...(replay.compactedWindow?.state === "ready" &&
        replay.compactedWindow.outputTokens !== undefined
          ? { outputTokens: replay.compactedWindow.outputTokens }
          : {}),
        item,
        replayIndex:
          replay.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
            ? contentLength
            : (replay.replayIndex ?? 0),
      };
    }
    const item: ResponseCompactionItemParam = {
      type: "compaction",
      ...(isSafeResponsesReplayItemId(replay.id) ? { id: replay.id } : {}),
      encrypted_content: replay.data,
    };
    publishResponsesCompactionInput(replay, [item], resolveImmutableData?.());
    return { item, mode: "compacted-prefix", replayIndex: replay.replayIndex ?? 0 };
  };
}

export class CompactionReplayRefreshRequiredError extends Error {
  constructor() {
    super(
      "Provider compaction checkpoint needs rebuilding. Run /compact to rebuild from saved conversation history.",
    );
    this.name = "CompactionReplayRefreshRequiredError";
  }
}
