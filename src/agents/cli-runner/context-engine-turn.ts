import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
} from "../harness/context-engine-lifecycle.js";
import { loadCliSessionContextEngineMessages } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

/**
 * Bootstraps the turn's context engine, then assembles it for its system prompt addition.
 * Returns the post-bootstrap history the turn's finalization reports to the engine.
 */
export async function startCliContextEngineTurn(context: PreparedCliRunContext) {
  const { params, contextEngine } = context;
  const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
    backendId: context.backendResolved.id,
  });
  const transcriptReadFence = params.sessionManager
    ? undefined
    : params.userTurnTranscriptRecorder?.getAdmissionReceipt();
  await bootstrapHarnessContextEngine({
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
    hadSessionFile: context.hadSessionFile,
    contextEngine,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    sessionManager: params.sessionManager,
    transcriptReadFence,
    config: context.contextEngineConfig,
    contextEngineHostSupport,
    providerId: params.provider,
    modelId: context.modelId,
    warn: (message) => log.warn(message),
  });
  if (!contextEngine) {
    return [];
  }
  const historyMessages = await loadCliSessionContextEngineMessages(params);
  // The native CLI session owns history, so only the engine's instructions are used.
  try {
    const assembled = await assembleHarnessContextEngine({
      contextEngine,
      admittedRunContext: params.admittedRunContext,
      preparedRunAdmission: params.preparedRunAdmission,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messages: historyMessages,
      tokenBudget: context.contextWindowInfo?.tokens,
      modelId: context.modelId,
      providerId: params.provider,
      contextEngineHostSupport,
      transcriptReadFence,
      prompt: context.contextEngineTurnPrompt,
    });
    context.contextEngineSystemPromptAddition =
      assembled?.systemPromptAddition?.trim() || undefined;
  } catch (error) {
    log.warn(`context engine assemble failed: ${formatErrorMessage(error)}`);
  }
  return historyMessages;
}
