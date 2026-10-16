import {
  type assembleHarnessContextEngine,
  estimateRenderedLlmBoundaryTokenPressure,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  readContextEngineThreadBootstrapProjection,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import {
  isCodexDurableCustomMessage,
  projectContextEngineAssemblyForCodex,
} from "./context-engine-projection.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import type { CodexAttemptContext } from "./run-attempt-context.js";
import {
  buildContextEngineBinding,
  resolveCodexHistorySelection,
} from "./thread-context-engine.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { buildCodexHistoryItems } from "./user-input.js";

type ProjectionParams = Parameters<typeof projectContextEngineAssemblyForCodex>[0];

export function resolveCodexPreservedHistoryTokenBudget(
  promptBudget:
    | (NonNullable<Parameters<typeof assembleHarnessContextEngine>[0]["promptBudget"]> & {
        contextTokens: number;
      })
    | undefined,
) {
  return promptBudget
    ? Math.max(
        1,
        Math.max(
          1,
          Math.floor(promptBudget.contextTokens) -
            Math.max(0, Math.floor(promptBudget.reserveTokens)),
        ) -
          Math.max(0, Math.floor(promptBudget.inputTokens ?? 0)) -
          estimateRenderedLlmBoundaryTokenPressure(promptBudget),
      )
    : undefined;
}

export async function prepareCodexContextEngineHistory(params: {
  assembled: {
    messages: ProjectionParams["assembledMessages"];
    contextProjection?: Parameters<typeof readContextEngineThreadBootstrapProjection>[0];
    systemPromptAddition?: ProjectionParams["systemPromptAddition"];
  };
  runtimeParams: CodexAttemptContext["runtime"]["runtimeParams"];
  startupBinding: CodexAttemptContext["runtime"]["connection"]["mutable"]["startupBinding"];
  toolSpecs: Parameters<typeof codexDynamicToolsFingerprint>[0];
  hasContinuation: boolean;
  continuationMessages: ProjectionParams["assembledMessages"] | undefined;
  preserveToolPayload: boolean;
  projectionParams: Omit<
    ProjectionParams,
    "assembledMessages" | "systemPromptAddition" | "toolPayloadMode"
  >;
  assertCurrent: () => void;
}) {
  const { assembled, projectionParams, startupBinding, assertCurrent } = params;
  const seedHistory = projectionParams.preserveAssembledHistory === true;
  const selectedMessages = [...assembled.messages, ...(params.continuationMessages ?? [])].filter(
    (message) =>
      (message.role !== "custom" || isCodexDurableCustomMessage(message)) &&
      !(
        message.role === "user" &&
        projectionParams.currentUserTurnIdempotencyKey &&
        Reflect.get(message, "idempotencyKey") === projectionParams.currentUserTurnIdempotencyKey
      ),
  );
  const selection = seedHistory
    ? resolveCodexHistorySelection(
        selectedMessages,
        assembled.contextProjection,
        startupBinding?.contextEngine?.projection?.fingerprint,
      )
    : undefined;
  const contextEngineProjection =
    selection?.projection ??
    readContextEngineThreadBootstrapProjection(assembled.contextProjection);
  const projectionDecision =
    contextEngineProjection && !params.hasContinuation
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding,
          expectedBinding: buildContextEngineBinding(
            { ...params.runtimeParams },
            contextEngineProjection,
          ),
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(params.toolSpecs),
          legacyDynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(params.toolSpecs),
        })
      : { project: true, reason: "per-turn-projection" };
  const renderProjection = (includeAttachments: boolean, messages = selectedMessages) =>
    projectContextEngineAssemblyForCodex({
      ...projectionParams,
      assembledMessages: messages,
      systemPromptAddition: assembled.systemPromptAddition,
      toolPayloadMode: contextEngineProjection || params.preserveToolPayload ? "preserve" : "elide",
      prepareFileContext: includeAttachments ? projectionParams.prepareFileContext : undefined,
    });
  const projection = await renderProjection(seedHistory || projectionDecision.project);
  assertCurrent();
  return {
    contextEngineProjection,
    projectionDecision,
    projection,
    preparedBootstrapProjection: contextEngineProjection ? () => renderProjection(true) : undefined,
    applyPromptState: async (
      promptState: CodexAttemptContext["promptState"],
      baseDeveloperInstructions: string,
    ) => {
      promptState.historyBootstrapItems =
        seedHistory && projection.promptContextRange
          ? buildCodexHistoryItems(
              `${projection.promptText.slice(0, projection.promptContextRange.end)}\n</conversation_context>`,
              projection.imageGroups,
            )
          : seedHistory
            ? []
            : undefined;
      promptState.historyDeltaItems = undefined;
      if (seedHistory && selection?.prefixLength !== undefined && !projectionDecision.project) {
        const delta = await renderProjection(true, selectedMessages.slice(selection.prefixLength));
        assertCurrent();
        promptState.historyDeltaItems = delta.promptContextRange
          ? buildCodexHistoryItems(
              `${delta.promptText.slice(0, delta.promptContextRange.end)}\n</conversation_context>`,
              delta.imageGroups,
            )
          : [];
      }
      promptState.promptText = seedHistory
        ? projection.currentRequestText
        : projectionDecision.project
          ? projection.promptText
          : projectionParams.prompt;
      promptState.promptContextRange =
        projectionDecision.project && !seedHistory ? projection.promptContextRange : undefined;
      promptState.developerInstructions = joinPresentSections(
        baseDeveloperInstructions,
        projection.developerInstructionAddition,
      );
    },
  };
}
