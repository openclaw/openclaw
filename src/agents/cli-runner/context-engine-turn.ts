import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildGenericCliContextEngineHostSupport,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
} from "../harness/context-engine-lifecycle.js";
import { beginContextEngineLogicalTurn } from "../harness/context-engine-turn-begin.js";
import { runCliCleanup } from "./cleanup.js";
import { cliBackendLog } from "./log.js";
import { loadCliSessionContextEngineMessages } from "./session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

/** The caller must register owned cleanup before validating the engine's host support. */
export async function prepareCliContextEngine(options: {
  run: RunCliAgentParams;
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  host: ContextEngineHostSupport;
}): Promise<{
  engine: ContextEngine;
  deferDisposalUntil?: PreparedCliRunContext["deferContextEngineDisposalUntil"];
  cleanup?: () => Promise<void>;
}> {
  const { run, config, agentDir, workspaceDir, host } = options;
  const lease = run.contextEngineLogicalTurnLease;
  if (lease) {
    const effective = await beginContextEngineLogicalTurn({
      lease,
      host,
      recorder: run.userTurnTranscriptRecorder,
      sessionTarget: run.sessionTarget,
    });
    return { engine: effective.engine, deferDisposalUntil: lease.deferDisposalUntil };
  }
  const trackDisposal = captureAsyncWorkTracker();
  const engine = await resolveContextEngine(config, {
    initialize: ensureContextEnginesInitialized,
    agentDir,
    workspaceDir,
  });
  const disposalHolds = new Set<Promise<void>>();
  const deferDisposalUntil = (promise: Promise<void>) => {
    disposalHolds.add(promise);
    void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
  };
  return {
    engine,
    deferDisposalUntil,
    cleanup: async () => {
      if (disposalHolds.size > 0) {
        // Queued maintenance may need this foreground turn to release its lane first.
        void trackDisposal(async () => {
          await Promise.allSettled(disposalHolds);
          await runCliCleanup(run, "cli-context-engine-release", async () => {
            await engine.dispose?.();
          });
        }).catch((error: unknown) => {
          cliBackendLog.warn(`CLI context engine cleanup failed: ${String(error)}`);
        });
      } else {
        await engine.dispose?.();
      }
    },
  };
}

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
