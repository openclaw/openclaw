import type { Context, Model, StreamFn, Usage } from "@openclaw/llm-core";
import type { OpenAIResponsesCompactionOutput } from "./openai-responses-compaction-window.js";
import type {
  OpenAIResponsesOptions,
  OpenAIResponsesReasoningReplayMetadata,
} from "./openai-responses-contracts.js";

export type OpenAIResponsesCompactEndpointResult = {
  output: OpenAIResponsesCompactionOutput;
  item: { type: "compaction"; id?: string; encrypted_content: string };
  historyMode: "compacted-prefix" | "retained-users";
  usage: Record<string, unknown> & { input_tokens: number; output_tokens: number };
  /** Normal Responses accounting, including cache splits and service-tier pricing. */
  modelUsage?: Usage;
  model: Model;
  replayMetadata: OpenAIResponsesReasoningReplayMetadata;
};

export type OpenAIResponsesV2ReplayBudget = {
  maxTokens: number;
  estimateTokens(output: OpenAIResponsesCompactionOutput, outputTokens: number): number;
};

type ResponsesCompactRequestController = {
  claimed: boolean;
  mode: "endpoint" | "v2";
  replayBudget?: OpenAIResponsesV2ReplayBudget;
  onClaimed(): void;
  resolve(result: OpenAIResponsesCompactEndpointResult): void;
  reject(error: unknown): void;
};

const COMPACT_REQUEST = Symbol("openaiResponsesCompactRequest");

export function claimResponsesCompactRequest(options: object | undefined) {
  const controller = options
    ? (Reflect.get(options, COMPACT_REQUEST) as ResponsesCompactRequestController | undefined)
    : undefined;
  if (controller?.claimed === false) {
    controller.claimed = true;
    controller.onClaimed();
    return controller;
  }
  return undefined;
}

/** Preserve the operation when a provider translates simple stream options. */
export function copyResponsesCompactRequest(source: object | undefined, target: object): void {
  const request = source ? Reflect.get(source, COMPACT_REQUEST) : undefined;
  if (request) {
    Reflect.set(target, COMPACT_REQUEST, request);
  }
}

/** Run provider compaction through the session's prepared stream stack. */
export async function requestPreparedOpenAIResponsesCompaction(
  streamFn: StreamFn,
  model: Model,
  context: Context,
  options: OpenAIResponsesOptions,
  mode: "endpoint" | "v2" = "endpoint",
  replayBudget?: OpenAIResponsesV2ReplayBudget,
): Promise<OpenAIResponsesCompactEndpointResult> {
  const preparedOptions = { ...options };
  let resolveResult!: (result: OpenAIResponsesCompactEndpointResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<OpenAIResponsesCompactEndpointResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let markClaimed!: () => void;
  const claimed = new Promise<void>((resolve) => {
    markClaimed = resolve;
  });
  const controller = {
    claimed: false,
    mode,
    replayBudget,
    onClaimed: markClaimed,
    resolve: resolveResult,
    reject: rejectResult,
  };
  Reflect.set(preparedOptions, COMPACT_REQUEST, controller);
  const stream = await Promise.resolve(
    streamFn(model, context, preparedOptions as Parameters<StreamFn>[2]),
  );
  try {
    // Session wrappers (auth, lifecycle runtime) may dispatch after returning their
    // stream, so the transport can claim the request only once the stream starts.
    const settled = stream.result().then(
      () => "settled" as const,
      () => "settled" as const,
    );
    if ((await Promise.race([claimed.then(() => "claimed" as const), settled])) !== "claimed") {
      throw new Error("Prepared stream did not reach an OpenAI Responses transport");
    }
    return await result;
  } finally {
    await stream.result().catch(() => undefined);
  }
}
