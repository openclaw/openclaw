import type { CliBackendPromptContext } from "../../plugins/cli-backend.types.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { buildAgentHookConversationMessages } from "../harness/hook-history.js";
import type { RunCliAgentParams } from "./types.js";

/** Text a CLI backend receives for one turn or one steered input. */
export type CliModelRequestPayload = {
  prompt: string;
  prependContext?: string;
  appendContext?: string;
};

/** Final gate before OpenClaw hands text to a CLI backend. Throws to stop the dispatch. */
export type CliModelRequestGate = (
  payload: CliModelRequestPayload,
  currentMessage?: unknown,
) => Promise<CliModelRequestPayload>;

type HookRunner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;

const PAYLOAD_KEYS = new Set(["prompt", "prependContext", "appendContext"]);

export function toCliModelRequestPayload(
  prompt: string,
  promptContext?: CliBackendPromptContext,
): CliModelRequestPayload {
  return {
    prompt,
    ...(promptContext?.prependContext ? { prependContext: promptContext.prependContext } : {}),
    ...(promptContext?.appendContext ? { appendContext: promptContext.appendContext } : {}),
  };
}

export function readCliPromptContext(
  payload: CliModelRequestPayload,
): CliBackendPromptContext | undefined {
  return payload.prependContext || payload.appendContext
    ? {
        ...(payload.prependContext ? { prependContext: payload.prependContext } : {}),
        ...(payload.appendContext ? { appendContext: payload.appendContext } : {}),
      }
    : undefined;
}

/** Plugins may rewrite text only; any other shape stops the dispatch. */
function readCliModelRequestPayload(value: unknown): CliModelRequestPayload {
  const invalid = () =>
    new Error(
      "before_model_request must keep the CLI payload as { prompt, prependContext?, appendContext? } strings",
    );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid();
  }
  // SAFETY: the guard above proved value is a non-null, non-array object; every field is read as unknown and validated below.
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PAYLOAD_KEYS.has(key))) {
    throw invalid();
  }
  const { prompt, prependContext, appendContext } = record;
  if (
    typeof prompt !== "string" ||
    (prependContext !== undefined && typeof prependContext !== "string") ||
    (appendContext !== undefined && typeof appendContext !== "string")
  ) {
    throw invalid();
  }
  return {
    prompt,
    ...(prependContext ? { prependContext } : {}),
    ...(appendContext ? { appendContext } : {}),
  };
}

/**
 * CLI runtimes have no provider payload: the backend owns its wire request. The hook sees and
 * may rewrite the text OpenClaw hands to the CLI, with the same opt-in, timeout, and
 * fail-closed policy as embedded provider requests.
 */
export function createCliModelRequestGate(params: {
  hookRunner: HookRunner;
  hookContext: PluginHookAgentContext;
  provider: string;
  model: string;
  /** Model-facing history for this turn, current user turn last. */
  messages: () => Promise<readonly unknown[]>;
}): CliModelRequestGate {
  return async (payload, currentMessage) => {
    if (!params.hookRunner.hasHooks("before_model_request")) {
      return payload;
    }
    // Handlers may edit the event payload in place, as on embedded runs.
    const requestPayload: CliModelRequestPayload = { ...payload };
    const result = await params.hookRunner.runBeforeModelRequest(
      {
        runtime: "cli",
        payload: requestPayload,
        provider: params.provider,
        model: params.model,
        messages: structuredClone([
          ...(await params.messages()),
          ...(currentMessage === undefined ? [] : [currentMessage]),
        ]),
      },
      params.hookContext,
    );
    return readCliModelRequestPayload(result ? result.payload : requestPayload);
  };
}

/** Gate for one CLI run; its prepared user row carries provenance and sender metadata. */
export function createCliRunModelRequestGate(params: {
  hookRunner: HookRunner;
  hookContext: PluginHookAgentContext;
  run: Pick<
    RunCliAgentParams,
    "provider" | "inputProvenance" | "senderIsOwner" | "userTurnTranscriptRecorder"
  >;
  model: string;
  prompt: string;
  history: () => readonly unknown[];
}): CliModelRequestGate {
  const { run } = params;
  let currentTurn: Promise<unknown> | undefined;
  return createCliModelRequestGate({
    hookRunner: params.hookRunner,
    hookContext: { ...params.hookContext, modelProviderId: run.provider, modelId: params.model },
    provider: run.provider,
    model: params.model,
    messages: async () => {
      currentTurn ??= Promise.resolve(run.userTurnTranscriptRecorder?.resolveMessage()).then(
        (message) =>
          message ??
          buildPersistedUserTurnMessage({
            text: params.prompt,
            provenance: run.inputProvenance,
            senderIsOwner: run.senderIsOwner,
          }),
      );
      return buildAgentHookConversationMessages({
        historyMessages: params.history(),
        currentTurnMessages: [await currentTurn],
      });
    },
  });
}
