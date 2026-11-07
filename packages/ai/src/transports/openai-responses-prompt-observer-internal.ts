import { isRecord } from "@openclaw/normalization-core";
import type { EasyInputMessage } from "openai/resources/responses/responses.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  responsesPromptObserver,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import {
  collectCompletionsRegions,
  collectResponsesRegions,
  promptPresenceExpectations,
  runPromptPresenceCheck,
} from "./prompt-presence-check.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

type ResponsesPromptRequest = {
  instructions?: unknown;
  input?: unknown;
  model?: unknown;
  reasoning?: { effort?: unknown };
  tools?: unknown;
};
type ResponsesPromptMetadata = Pick<ResponsesPromptObservation, "egress" | "payloadVariant">;

function readSessionsSpawnSchema(
  tools: unknown,
): ResponsesPromptObservation["sessionsSpawn"] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const tool = tools.find(
    (candidate) => isRecord(candidate) && candidate.name === "sessions_spawn",
  );
  if (!isRecord(tool)) {
    return undefined;
  }
  const parameters = isRecord(tool.parameters) ? tool.parameters : undefined;
  return {
    ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    categoryRequired:
      Array.isArray(parameters?.required) && parameters.required.includes("category"),
  };
}

function readFinalResponsesPrompt(
  request: ResponsesPromptRequest,
): [ResponsesPromptObservation["promptSource"], string] {
  if (typeof request.instructions === "string") {
    return ["instructions", request.instructions] as const;
  }
  const input = Array.isArray(request.input) ? request.input : [];
  const message = input.find((item) => {
    const role = (item as EasyInputMessage).role;
    return role === "developer" || role === "system";
  }) as EasyInputMessage | undefined;
  if (!message) {
    return ["missing", ""] as const;
  }
  const content = message.content;
  const observedPrompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join("")
        : "";
  return [
    message.role === "developer" ? "input.developer" : "input.system",
    observedPrompt,
  ] as const;
}

export function createResponsesPromptEgressObserver(
  options: object | undefined,
  assembledPrompt: string | undefined,
) {
  const observer = options ? responsesPromptObserver.get(options) : undefined;
  if (!observer) {
    return undefined;
  }
  const expectedPrompt = sanitizeTransportPayloadText(
    stripSystemPromptCacheBoundary(assembledPrompt ?? ""),
  );
  const carrier = options ? promptPresenceExpectations.get(options) : undefined;
  const expectations = carrier?.expectations;
  let attemptCounter = 0;
  return (request: ResponsesPromptRequest, metadata: ResponsesPromptMetadata) => {
    const [promptSource, observedPrompt] = readFinalResponsesPrompt(request);
    const sessionsSpawn = readSessionsSpawnSchema(request.tools);
    const attemptIndex = attemptCounter++;
    const presenceCheck = expectations
      ? runPromptPresenceCheck({
          collected: collectResponsesRegions(request),
          expectations,
          attemptIndex,
        })
      : undefined;
    observer({
      ...metadata,
      promptSource,
      expectedChars: expectedPrompt.length,
      observedChars: observedPrompt.length,
      matchesAssembledPrompt: promptSource !== "missing" && observedPrompt === expectedPrompt,
      ...(presenceCheck
        ? { presenceCheck: { ...presenceCheck, expectationsOverflow: carrier?.overflowCount } }
        : {}),
      ...(typeof request.model === "string" ? { model: request.model } : {}),
      ...(typeof request.reasoning?.effort === "string"
        ? { reasoningEffort: request.reasoning.effort }
        : {}),
      ...(sessionsSpawn ? { sessionsSpawn } : {}),
    });
  };
}

export function createCompletionsPromptEgressObserver(
  options: object | undefined,
  assembledPrompt: string | undefined,
) {
  const observer = options ? responsesPromptObserver.get(options) : undefined;
  if (!observer) {
    return undefined;
  }
  const carrier = options ? promptPresenceExpectations.get(options) : undefined;
  const expectations = carrier?.expectations;
  const expectedPrompt = sanitizeTransportPayloadText(
    stripSystemPromptCacheBoundary(assembledPrompt ?? ""),
  );
  return (params: unknown) => {
    const collected = collectCompletionsRegions(params);
    const firstLegal = collected.legal[0];
    const presenceCheck = expectations
      ? runPromptPresenceCheck({ collected, expectations, attemptIndex: 0 })
      : undefined;
    observer({
      egress: "completions",
      payloadVariant: "initial",
      promptSource: firstLegal ? "input.system" : "missing",
      expectedChars: expectedPrompt.length,
      observedChars: firstLegal ? firstLegal.text.length : 0,
      matchesAssembledPrompt: firstLegal !== undefined && firstLegal.text === expectedPrompt,
      ...(presenceCheck
        ? { presenceCheck: { ...presenceCheck, expectationsOverflow: carrier?.overflowCount } }
        : {}),
    });
  };
}
