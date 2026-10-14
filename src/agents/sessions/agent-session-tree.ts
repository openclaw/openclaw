import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import {
  collectEntriesForBranchSummaryFromBranches,
  generateBranchSummary,
} from "../runtime/index.js";
import { AgentSessionExecution } from "./agent-session-execution.js";
import { extractTextContent } from "./agent-session-utils.js";
import { createCompactionRuntime } from "./compaction/runtime.js";
import type { ExtensionRunner, TreePreparation } from "./extensions/index.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import type { BranchSummaryEntry } from "./session-manager.js";
import { recordSessionModelUsage } from "./session-model-usage.js";

export abstract class AgentSessionTree extends AgentSessionExecution {
  /**
   * Navigate to a different node in the session tree.
   * Unlike fork() which creates a new session file, this stays in the same file.
   *
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.replaceInstructions If true, customInstructions replaces the default prompt
   * @param options.label Label to attach to the branch summary entry
   * @returns Result with editorText (if user message) and cancelled status
   */
  async navigateTree(
    targetId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {},
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
    summaryEntry?: BranchSummaryEntry;
  }> {
    const oldLeafId = this.sessionManager.getLeafId();

    if (targetId === oldLeafId) {
      return { cancelled: false };
    }

    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization");
    }

    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }

    const { entries: entriesToSummarize, commonAncestorId } = oldLeafId
      ? collectEntriesForBranchSummaryFromBranches(
          this.sessionManager.getBranch(oldLeafId),
          this.sessionManager.getBranch(targetId),
        )
      : { entries: [], commonAncestorId: null };

    // Prepare event data - mutable so extensions can override
    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;

    const preparation: TreePreparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
      customInstructions,
      replaceInstructions,
      label,
    };

    const abortController = new AbortController();
    this.branchSummaryAbortController = abortController;

    try {
      let extensionSummary: { summary: string; details?: unknown } | undefined;

      if (this.currentExtensionRunner.hasHandlers("session_before_tree")) {
        const result = await this.currentExtensionRunner.emit({
          type: "session_before_tree",
          preparation,
          signal: abortController.signal,
        });

        if (result?.cancel) {
          return { cancelled: true };
        }

        if (result?.summary && options.summarize) {
          extensionSummary = result.summary;
        }

        if (result?.customInstructions !== undefined) {
          customInstructions = result.customInstructions;
        }
        if (result?.replaceInstructions !== undefined) {
          replaceInstructions = result.replaceInstructions;
        }
        if (result?.label !== undefined) {
          label = result.label;
        }
      }

      const fromExtension = extensionSummary !== undefined;
      let summaryText: string | undefined;
      let summaryDetails: unknown;
      if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
        const model = this.model!;
        const { apiKey, headers } = await this.getRequiredRequestAuth(model);
        const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
        const result = await generateBranchSummary(entriesToSummarize, {
          model,
          apiKey,
          headers,
          signal: abortController.signal,
          customInstructions,
          replaceInstructions,
          reserveTokens: branchSummarySettings.reserveTokens,
          streamFn: this.agent.streamFn,
          runtime: createCompactionRuntime((usage) =>
            recordSessionModelUsage(this.sessionManager, usage),
          ),
        });
        if (!result.ok) {
          if (result.error.code === "aborted") {
            return { cancelled: true, aborted: true };
          }
          throw new Error(result.error.message);
        }
        summaryText = result.value.summary;
        summaryDetails = {
          readFiles: result.value.readFiles,
          modifiedFiles: result.value.modifiedFiles,
        };
      } else if (extensionSummary) {
        summaryText = extensionSummary.summary;
        summaryDetails = extensionSummary.details;
      }

      let newLeafId: string | null;
      let editorText: string | undefined;

      if (targetEntry.type === "message" && targetEntry.message.role === "user") {
        newLeafId = targetEntry.parentId;
        editorText = extractTextContent(targetEntry.message.content);
      } else if (targetEntry.type === "custom_message") {
        newLeafId = targetEntry.parentId;
        editorText = extractTextContent(targetEntry.content);
      } else {
        newLeafId = targetId;
      }

      const navigation = await withSessionManagerWrite(this.sessionManager, async () => {
        if (
          abortController.signal.aborted ||
          this.branchSummaryAbortController !== abortController
        ) {
          return { cancelled: true, aborted: true } as const;
        }
        // Summary and labels belong to the navigation target, not the old branch.
        // Publish the selected context only after its persistence has settled.
        const mutate = async () => {
          let summaryEntry: BranchSummaryEntry | undefined;
          if (summaryText) {
            const summaryId = await this.sessionManager.branchWithSummaryAsync(
              newLeafId,
              summaryText,
              summaryDetails,
              fromExtension,
            );
            summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
            if (label) {
              await this.sessionManager.appendLabelChangeAsync(summaryId, label);
            }
          } else if (newLeafId === null) {
            await this.sessionManager.resetLeafAsync();
          } else {
            await this.sessionManager.branchAsync(newLeafId);
          }
          if (label && !summaryText) {
            await this.sessionManager.appendLabelChangeAsync(targetId, label);
          }
          const sessionContext = this.sessionManager.buildSessionContext();
          this.agent.state.messages = sanitizeCompactionReplayMessages(sessionContext.messages);
          return { cancelled: false, summaryEntry } as const;
        };
        const target = this.sessionManager.getSessionTarget();
        return target
          ? await withSessionTranscriptWriteAssertion(
              target,
              () => {
                abortController.signal.throwIfAborted();
                if (this.branchSummaryAbortController !== abortController) {
                  throw new Error("Session tree navigation changed before transcript commit");
                }
              },
              mutate,
            )
          : await mutate();
      });
      if (navigation.cancelled) {
        return navigation;
      }
      const { summaryEntry } = navigation;

      await this.currentExtensionRunner.emit({
        type: "session_tree",
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : undefined,
      });

      return { editorText, cancelled: false, summaryEntry };
    } finally {
      if (this.branchSummaryAbortController === abortController) {
        this.branchSummaryAbortController = undefined;
      }
    }
  }

  get extensionRunner(): ExtensionRunner {
    return this.currentExtensionRunner;
  }
}
