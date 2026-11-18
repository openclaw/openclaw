import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { InvalidSummaryOutputError } from "../../../packages/agent-core/src/harness/types.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { AssistantMessage, ModelRequestHeaders } from "../../llm/types.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import { buildCoreCompactionInstructions } from "../agent-hooks/compaction-instructions.js";
import { setCompactionSafeguardCancellation } from "../agent-hooks/compaction-safeguard-runtime.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import {
  compactWithoutNewSummary,
  settleCompactionSafeguardCancellation,
  settleCompactionSummary,
  withCompactionSummaryRoute,
} from "../compaction-summary-refusal.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  shouldCompact,
  type CompactionResult,
} from "../runtime/index.js";
import { AgentSessionInspection } from "./agent-session-inspection.js";
import {
  agentSessionDeferThresholdCompaction,
  agentSessionRunProviderCompaction,
} from "./agent-session-types.js";
import { compactionErrorMessage } from "./agent-session-utils.js";
import { formatNoModelSelectedMessage } from "./auth-guidance.js";
import {
  prepareAgentCompactionWork,
  createCompactionReplacementProjector,
} from "./compaction/preparation.js";
import type {
  CompactionSummaryOutputPolicy as SummaryOutputPolicy,
  CompactionRequestBudget,
  CompactionRequestConstraints,
} from "./compaction/preparation.types.js";
import {
  preparedSessionCompactionWork,
  type PreparedSessionCompactionWork,
} from "./compaction/prepared-work.js";
import {
  commitSessionCompactionSummary,
  createCompactionRequestBudget,
  estimateCompactedRequestTokens,
  replayTokenBudget,
} from "./compaction/request-budget.js";
import { createCompactionRuntime } from "./compaction/runtime.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import { recordSessionModelUsage } from "./session-model-usage.js";
import type { SettingsManager } from "./settings-manager.js";

type CompactionReason = "manual" | "threshold" | "overflow";
// onSummaryReady marks the end of summary generation; later waits are persistence, not summary.
// itemId: a caller that already announced this compaction keeps one identity for events and entry.
type AutomaticCompactionOptions = CompactionRequestConstraints & {
  onSummaryReady?: () => void;
  itemId?: string;
  [preparedSessionCompactionWork]?: PreparedSessionCompactionWork;
};
type CompactionWorkOutcome =
  | { status: "completed"; result: CompactionResult; tokensAfter: number }
  | { status: "aborted" }
  | { status: "skipped"; reason: string };
type SettledCompactionWorkOutcome = Exclude<CompactionWorkOutcome, { status: "aborted" }>;

/** @internal */
export const agentSessionAutomaticCompaction: unique symbol = Symbol.for(
  "openclaw.agent-session.automatic-compaction",
);

/** Installs a synchronous callback for model-context replacement during compaction. */
export const agentSessionSetContextReplacementHook: unique symbol = Symbol.for(
  "openclaw.agent-session.set-context-replacement-hook",
);

export abstract class AgentSessionCompaction extends AgentSessionInspection {
  [agentSessionDeferThresholdCompaction] = false;
  private onContextReplaced?: (
    tokensAfter: number,
    tokensBefore: number,
    details?: unknown,
  ) => void;
  private assertContextReplacementActive?: () => void;

  async [agentSessionRunProviderCompaction]<T>(
    run: (
      signal: AbortSignal,
      committed: (tokensBefore: number, tokensAfter: number) => void,
    ) => Promise<T>,
    hooksHandled = false,
  ): Promise<T> {
    const controller = new AbortController();
    const itemId = generateSessionEntryId();
    let committed = false;
    this.autoCompactionAbortController = controller;
    try {
      this.emit({ type: "compaction_start", reason: "threshold", itemId, hooksHandled });
      return await run(controller.signal, (tokensBefore, tokensAfter) => {
        // Publish the durable receipt before observers or write-handle release can fail.
        committed = true;
        this.emit({
          type: "compaction_end",
          reason: "threshold",
          itemId,
          hooksHandled,
          outcome: { status: "completed", tokensBefore, tokensAfter, willRetry: false },
        });
        this.onContextReplaced?.(tokensAfter, tokensBefore);
      });
    } catch (error) {
      if (!committed) {
        this.emit({
          type: "compaction_end",
          reason: "threshold",
          itemId,
          hooksHandled,
          outcome: controller.signal.aborted
            ? { status: "aborted" }
            : {
                status: "failed",
                reason: compactionErrorMessage(error, "Provider compaction failed"),
              },
        });
      }
      throw error;
    } finally {
      if (this.autoCompactionAbortController === controller) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }

  [agentSessionSetContextReplacementHook](
    callback: ((tokensAfter: number, tokensBefore: number, details?: unknown) => void) | undefined,
    assertActive?: () => void,
  ): void {
    this.onContextReplaced = callback;
    this.assertContextReplacementActive = assertActive;
  }

  override dispose(): void {
    this.onContextReplaced = undefined;
    super.dispose();
  }

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    return await this.runWithSessionWriteSettlement(async () => {
      const outcome = await this.compactWithSessionWriteSettlement(customInstructions, "none");
      if (outcome.status === "skipped") {
        throw new Error(outcome.reason);
      }
      return outcome.result;
    });
  }

  async [agentSessionAutomaticCompaction](
    customInstructions?: string,
    requestState?: "unresolved",
    summaryOutputPolicy: SummaryOutputPolicy = "retry-invalid-once",
    constraints?: AutomaticCompactionOptions,
  ): Promise<SettledCompactionWorkOutcome> {
    return await this.runWithSessionWriteSettlement(() =>
      this.compactWithSessionWriteSettlement(
        customInstructions,
        summaryOutputPolicy,
        requestState,
        constraints,
      ),
    );
  }

  private async compactWithSessionWriteSettlement(
    customInstructions?: string,
    summaryOutputPolicy: SummaryOutputPolicy = "none",
    requestState?: "unresolved",
    constraints?: AutomaticCompactionOptions,
  ): Promise<SettledCompactionWorkOutcome> {
    this.disconnectFromAgent();
    await this.abort();
    const abortController = new AbortController();
    this.compactionAbortController = abortController;
    const { itemId = generateSessionEntryId(), ...requestConstraints } = constraints ?? {};
    this.emit({ type: "compaction_start", reason: "manual", itemId });

    try {
      const settings = this.settingsManager.getCompactionSettings();
      let outcome: CompactionWorkOutcome;
      try {
        outcome = await this.runCompactionWork({
          itemId,
          customInstructions,
          mode: "manual",
          summaryOutputPolicy,
          requestState,
          ...requestConstraints,
          settings,
          signal: abortController.signal,
        });
      } catch (error) {
        const message = compactionErrorMessage(error, "Compaction failed");
        const aborted =
          abortController.signal.aborted || (error instanceof Error && error.name === "AbortError");
        this.emit({
          type: "compaction_end",
          reason: "manual",
          itemId,
          outcome: aborted
            ? { status: "aborted" }
            : { status: "failed", reason: `Compaction failed: ${message}` },
        });
        throw error;
      }
      if (outcome.status === "skipped") {
        this.emit({ type: "compaction_end", reason: "manual", itemId, outcome });
        return outcome;
      }
      if (outcome.status === "aborted") {
        this.emit({ type: "compaction_end", reason: "manual", itemId, outcome });
        throw new Error("Compaction cancelled");
      }

      this.emitCompletedCompaction("manual", itemId, outcome, false);
      return outcome;
    } finally {
      if (this.compactionAbortController === abortController) {
        this.compactionAbortController = undefined;
      }
      this.reconnectToAgent();
    }
  }

  private emitCompletedCompaction(
    reason: CompactionReason,
    itemId: string,
    outcome: Extract<CompactionWorkOutcome, { status: "completed" }>,
    willRetry: boolean,
  ): void {
    const details = parseCompactionDetails(outcome.result.details);
    this.emit({
      type: "compaction_end",
      reason,
      itemId,
      outcome: {
        status: "completed",
        tokensBefore: outcome.result.tokensBefore,
        tokensAfter: outcome.tokensAfter,
        willRetry,
        ...(details?.qualityDegraded ? { qualityDegraded: true } : {}),
        ...(details?.summaryRefused ? { summaryRefused: true } : {}),
      },
    });
  }

  /** Cancel in-progress compaction (manual or auto). */
  abortCompaction(): void {
    this.compactionAbortController?.abort();
    this.autoCompactionAbortController?.abort();
  }

  private async runCompactionWork(options: {
    itemId: string;
    settings: ReturnType<SettingsManager["getCompactionSettings"]>;
    signal: AbortSignal;
    customInstructions?: string;
    mode: "manual" | "auto";
    requestState?: "unresolved";
    summaryOutputPolicy: SummaryOutputPolicy;
    requestBudget?: CompactionRequestBudget;
    requestFromEntryId?: string;
    pendingUserEntryId?: string;
    requestRequiresCompaction?: true;
    onSummaryReady?: () => void;
    [preparedSessionCompactionWork]?: PreparedSessionCompactionWork;
  }): Promise<CompactionWorkOutcome> {
    const isManual = options.mode === "manual";
    const assertContextReplacementActive = this.assertContextReplacementActive;
    const onContextReplaced = this.onContextReplaced;
    if (!this.model) {
      if (isManual) {
        throw new Error(formatNoModelSelectedMessage());
      }
      return { status: "skipped", reason: formatNoModelSelectedMessage() };
    }
    const model = this.model;
    const compactionThinkingLevel =
      this.resolveCompactionThinkingLevel?.(model, this.thinkingLevel) ?? this.thinkingLevel;

    let auth: { apiKey?: string; headers?: ModelRequestHeaders } = {};
    if (options.summaryOutputPolicy !== "deterministic") {
      try {
        auth = await this.getCompactionRequestAuth(model);
      } catch (error) {
        if (isManual) {
          throw error;
        }
        return {
          status: "skipped",
          reason: compactionErrorMessage(error, "Compaction authentication failed"),
        };
      }
    }

    const pathEntries = this.sessionManager.getBranch();
    const privateWork = options[preparedSessionCompactionWork];
    const prepared = privateWork
      ? {
          status: "prepared" as const,
          requestBudget: privateWork.requestBudget,
          pendingEntryIndex: privateWork.pendingEntryId
            ? pathEntries.findIndex((entry) => entry.id === privateWork.pendingEntryId)
            : -1,
          requestTokenLimit: privateWork.requestTokenLimit,
          preparation: privateWork.preparation,
          projectReplacement: createCompactionReplacementProjector(pathEntries, options.itemId),
        }
      : prepareAgentCompactionWork(pathEntries, {
          ...options,
          contextWindow: model.contextWindow,
          systemPrompt: this.agent.state.systemPrompt,
          tools: this.agent.state.tools,
        });
    if (prepared.status === "skipped") {
      return prepared;
    }
    const { requestBudget, pendingEntryIndex, requestTokenLimit, preparation, projectReplacement } =
      prepared;
    const assertPreparedCurrent = () => {
      if (!privateWork) {
        return;
      }
      // Auth above can await: prepared facts never replace live custody.
      options.signal.throwIfAborted();
      const controller = isManual
        ? this.compactionAbortController
        : this.autoCompactionAbortController;
      if (controller?.signal !== options.signal) {
        throw new Error("Prepared compaction context changed before summary execution");
      }
      assertContextReplacementActive?.();
      if (privateWork.pendingEntryId && pendingEntryIndex < 0) {
        throw new Error("Compaction cannot find the admitted pending user request.");
      }
      if (!pathEntries.some((entry) => entry.id === preparation.firstKeptEntryId)) {
        throw new Error("Prepared compaction lost its retained boundary");
      }
    };
    assertPreparedCurrent();

    let compactionResult: CompactionResult | undefined;
    let fromExtension = false;
    let withoutSummary = options.summaryOutputPolicy === "deterministic";
    if (withoutSummary) {
      // Summary producers, including session_before_compact hooks, already failed.
      compactionResult = compactWithoutNewSummary(
        preparation,
        this.sessionManager,
        privateWork?.deterministic,
      );
    } else if (privateWork || this.currentExtensionRunner.hasHandlers("session_before_compact")) {
      // Cancellation provenance belongs to this attempt; an earlier hook may decline first.
      setCompactionSafeguardCancellation(this.sessionManager, undefined);
      const event = {
        type: "session_before_compact" as const,
        preparation,
        branchEntries: pathEntries,
        customInstructions: options.customInstructions,
        signal: options.signal,
        // Extension-owned compaction must use the same prepared model execution
        // context as the core path below or provider wrappers and reasoning drift.
        thinkingLevel: compactionThinkingLevel,
        streamFn: this.agent.streamFn,
      };
      // Only the privately constructed builtin accepts omitted history arrays.
      // Public mutable extension inputs continue through the unchanged runner.
      const extensionResult = privateWork
        ? await privateWork.execute(event, {
            model,
            modelRegistry: this.modelRegistry,
            sessionManager: this.sessionManager,
          })
        : await this.currentExtensionRunner.emit(event);
      if (privateWork) {
        if (options.signal.aborted) {
          return { status: "aborted" };
        }
        // Recovery can record a failed attempt: revalidate before that write too.
        assertPreparedCurrent();
      }

      if (extensionResult?.cancel) {
        const floor = await settleCompactionSafeguardCancellation(
          this.sessionManager,
          preparation,
          options,
          privateWork?.deterministic,
        );
        if (!floor) {
          return { status: "aborted" };
        }
        compactionResult = floor;
        withoutSummary = true;
      }

      if (extensionResult?.compaction) {
        compactionResult = extensionResult.compaction;
        fromExtension = true;
      }
    }

    if (!compactionResult && privateWork) {
      throw new Error("Prepared builtin compaction did not settle its summary");
    }
    if (!compactionResult) {
      const coreInstructions = buildCoreCompactionInstructions(
        options.customInstructions,
        preparation.latestUnresolvedUserRequest,
      );
      const runCoreCompaction = () =>
        compact(
          preparation,
          model,
          auth.apiKey,
          auth.headers,
          coreInstructions,
          options.signal,
          compactionThinkingLevel,
          this.agent.streamFn,
          createCompactionRuntime((usage) => recordSessionModelUsage(this.sessionManager, usage)),
        );
      let result = await runCoreCompaction();
      // Automatic core compaction owns one retry for invalid summary output.
      // Manual, provider-error, and extension-owned paths keep their own policy.
      if (options.signal.aborted) {
        return { status: "aborted" };
      }
      if (
        options.summaryOutputPolicy === "retry-invalid-once" &&
        !result.ok &&
        result.error instanceof InvalidSummaryOutputError
      ) {
        result = await runCoreCompaction();
        if (options.signal.aborted) {
          return { status: "aborted" };
        }
      }
      compactionResult = settleCompactionSummary(result, preparation, this.sessionManager);
    }
    options.onSummaryReady?.();

    if (options.signal.aborted) {
      return { status: "aborted" };
    }

    const completedCompaction = {
      ...withCompactionSummaryRoute(compactionResult, this.sessionManager, model, withoutSummary),
      summary: commitSessionCompactionSummary(
        compactionResult,
        preparation,
        withoutSummary,
        () =>
          privateWork
            ? privateWork.summaryReplayTokenBudget
            : replayTokenBudget(
                this,
                model,
                options.settings,
                projectReplacement(compactionResult, ""),
              ),
        privateWork?.floor,
      ),
    };

    // Custom hooks may choose a different retained boundary. Validate their
    // complete result before commit, without modifying an already audited artifact.
    const { firstKeptEntryId } = completedCompaction;
    const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    if (pendingEntryIndex >= 0 && (firstKeptIndex < 0 || firstKeptIndex > pendingEntryIndex)) {
      throw new Error("Compaction must retain the unprocessed pending user request.");
    }
    if (
      requestBudget &&
      requestTokenLimit !== undefined &&
      estimateCompactedRequestTokens(
        projectReplacement(completedCompaction, completedCompaction.summary),
        requestBudget,
      ) > requestTokenLimit
    ) {
      throw new Error(
        "The finalized compaction exceeds the foreground request budget. Reduce the request or select a larger context window.",
      );
    }

    const committed = await withSessionManagerWrite(this.sessionManager, async () => {
      const currentController = isManual
        ? this.compactionAbortController
        : this.autoCompactionAbortController;
      if (options.signal.aborted || currentController?.signal !== options.signal) {
        return undefined;
      }
      // Revalidate after admission too. In-memory transcripts have no SQLite
      // writer fence, and cancellation must not publish a replaced context.
      assertContextReplacementActive?.();
      const replacementMessages = sanitizeCompactionReplayMessages(
        projectReplacement(completedCompaction, completedCompaction.summary),
      );
      const tokensAfter = requestBudget
        ? estimateCompactedRequestTokens(replacementMessages, {
            ...requestBudget,
            pendingTokens: 0,
          })
        : estimateContextTokens(replacementMessages).tokens;
      const assertCommitCurrent = () => {
        options.signal.throwIfAborted();
        const controller = isManual
          ? this.compactionAbortController
          : this.autoCompactionAbortController;
        if (controller?.signal !== options.signal) {
          throw new Error("Compaction context changed before transcript commit");
        }
        assertContextReplacementActive?.();
      };
      const append = () =>
        this.sessionManager.appendCompactionAsync(
          completedCompaction.summary,
          completedCompaction.firstKeptEntryId,
          completedCompaction.tokensBefore,
          completedCompaction.details,
          fromExtension,
          { itemId: options.itemId },
          tokensAfter,
        );
      const target = this.sessionManager.getSessionTarget();
      const entryId = await (target
        ? withSessionTranscriptWriteAssertion(target, assertCommitCurrent, append)
        : append());
      const sessionContext = this.sessionManager.buildSessionContext();
      // Publish the committed replacement and accounting together after its receipt.
      this.agent.state.messages = sanitizeCompactionReplayMessages(sessionContext.messages);
      onContextReplaced?.(
        tokensAfter,
        completedCompaction.tokensBefore,
        completedCompaction.details,
      );
      return { entryId, tokensAfter };
    });
    if (committed === undefined) {
      return { status: "aborted" };
    }
    const { entryId: compactionEntryId, tokensAfter } = committed;

    const savedCompactionEntry = this.sessionManager.getEntry(compactionEntryId);
    if (this.currentExtensionRunner && savedCompactionEntry?.type === "compaction") {
      await this.currentExtensionRunner.emit({
        type: "session_compact",
        compactionEntry: savedCompactionEntry,
        fromExtension,
      });
    }

    return { status: "completed", result: completedCompaction, tokensAfter };
  }

  protected async checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
    requestBudget?: CompactionRequestBudget,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) {
      return false;
    }

    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") {
      return false;
    }

    const contextWindow = this.model?.contextWindow ?? 0;

    // Skip overflow check if the message came from a different model.
    // This handles the case where user switched from a smaller-context model (e.g. opus)
    // to a larger-context model (e.g. codex) - the overflow error from the old model
    // shouldn't trigger compaction for the new model.
    const sameModel =
      this.model &&
      assistantMessage.provider === this.model.provider &&
      assistantMessage.model === this.model.id;

    // Skip compaction checks if this assistant message is older than the latest
    // compaction boundary. This prevents a stale pre-compaction usage/error
    // from retriggering compaction on the first prompt after compaction.
    const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
    const assistantIsFromBeforeCompaction =
      compactionEntry !== null &&
      assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) {
      return false;
    }

    // Case 1: Overflow - an unsuccessful response needs compact-and-retry recovery.
    // Successful high-usage responses fall through to threshold maintenance below.
    if (
      sameModel &&
      (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "length") &&
      isContextOverflow(assistantMessage, contextWindow)
    ) {
      if (this.contextOverflowRecoveryOwner === "caller") {
        return false;
      }
      if (this.overflowRecoveryAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
        this.emit({
          type: "compaction_end",
          reason: "overflow",
          outcome: {
            status: "failed",
            reason: `Context overflow recovery failed after ${MAX_OVERFLOW_COMPACTION_ATTEMPTS} compact-and-retry attempts. Try reducing context or switching to a larger-context model.`,
          },
        });
        return false;
      }

      this.overflowRecoveryAttempts += 1;
      // Keep the failed response in history, but exclude it from the retry context.
      const messages = this.agent.state.messages;
      if (messages.at(-1)?.role === "assistant") {
        this.agent.state.messages = messages.slice(0, -1);
      }
      return await this.runAutoCompaction("overflow", true, requestBudget);
    }

    if (this[agentSessionDeferThresholdCompaction]) {
      return false;
    }

    // For error messages (no usage data), estimate from last successful response.
    // This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
    let contextTokens: number;
    if (assistantMessage.stopReason === "error") {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) {
        return false;
      }
      contextTokens = estimate.tokens;
    } else if (assistantMessage.usage.contextUsage?.state === "unavailable") {
      const estimatedContextTokens = this.getContextUsage()?.tokens;
      if (estimatedContextTokens == null) {
        return false;
      }
      contextTokens = estimatedContextTokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      return await this.runAutoCompaction("threshold", false, requestBudget);
    }
    return false;
  }

  private async runAutoCompaction(
    reason: Exclude<CompactionReason, "manual">,
    willRetry: boolean,
    requestBudget?: CompactionRequestBudget,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();
    const contextWindow = this.model?.contextWindow;

    const itemId = generateSessionEntryId();
    this.emit({ type: "compaction_start", reason, itemId });
    const abortController = new AbortController();
    this.autoCompactionAbortController = abortController;

    try {
      const outcome = await this.runCompactionWork({
        itemId,
        mode: "auto",
        requestBudget:
          requestBudget ??
          (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
            ? createCompactionRequestBudget({
                contextWindow,
                reserveTokens: settings.reserveTokens,
                systemPrompt: this.agent.state.systemPrompt,
                tools: this.agent.state.tools,
              })
            : undefined),
        ...(willRetry ? { requestState: "unresolved" as const } : {}),
        summaryOutputPolicy: "retry-invalid-once",
        settings,
        signal: abortController.signal,
      });
      if (outcome.status !== "completed") {
        this.emit({ type: "compaction_end", reason, itemId, outcome });
        return false;
      }
      this.emitCompletedCompaction(reason, itemId, outcome, willRetry);

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg?.role === "assistant" &&
          (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")
        ) {
          this.agent.state.messages = messages.slice(0, -1);
        }
        return true;
      }

      // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
      // Continue once so queued messages are delivered.
      return this.agent.hasQueuedMessages();
    } catch (error) {
      if (abortController.signal.aborted) {
        this.emit({ type: "compaction_end", reason, itemId, outcome: { status: "aborted" } });
        return false;
      }
      const errorMessage = compactionErrorMessage(error, "compaction failed");
      this.emit({
        type: "compaction_end",
        reason,
        itemId,
        outcome: {
          status: "failed",
          reason:
            reason === "overflow"
              ? `Context overflow recovery failed: ${errorMessage}`
              : `Auto-compaction failed: ${errorMessage}`,
        },
      });
      return false;
    } finally {
      if (this.autoCompactionAbortController === abortController) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }

  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }
}
