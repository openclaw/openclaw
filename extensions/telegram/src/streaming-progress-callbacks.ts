import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
} from "openclaw/plugin-sdk/channel-outbound";
import type { StreamingCompatEntry } from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";

/**
 * Status-reaction surface the native inbound dispatch drives from progress events.
 * Optional — the streaming-echo renderer has no reaction controller and passes none.
 */
export type TelegramProgressStatusReactions = {
  setTool: (toolName: string) => Promise<void> | void;
  setCompacting: () => Promise<void> | void;
  cancelPending: () => void;
  setThinking: () => Promise<void> | void;
};

/**
 * The streaming tool/commentary progress callback bundle, factored out of the
 * native Telegram dispatch so BOTH the inbound dispatch and the streaming-echo
 * renderer (echo-renderer.ts) drive progress through the exact same code path —
 * no duplicated wiring. Each callback funnels into the shared progress-draft
 * compositor via `pushToolProgress` / `pushCommentaryProgress`; the compositor is
 * what rides the destination's `streaming.preview.toolProgress` / `progress.*`
 * config, so honoring that config lives in one place.
 */
export function buildTelegramProgressCallbacks(deps: {
  entry: StreamingCompatEntry | null | undefined;
  /** Guarded `progressDraft.pushToolProgress` (no-ops once the final reply starts). */
  pushToolProgress: (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => Promise<boolean> | boolean;
  pushCommentaryProgress: (
    text?: string,
    options?: { itemId?: string },
  ) => Promise<unknown> | unknown;
  /** True while the durable verbose lane owns commentary (preamble yields to it). */
  verboseProgressActive?: () => boolean;
  statusReactionController?: TelegramProgressStatusReactions | null;
}): Pick<
  GetReplyOptions,
  | "onToolStart"
  | "onItemEvent"
  | "onPlanUpdate"
  | "onApprovalEvent"
  | "onCommandOutput"
  | "onPatchSummary"
  | "onCompactionStart"
  | "onCompactionEnd"
> {
  const { entry, pushToolProgress, pushCommentaryProgress, statusReactionController } = deps;
  const verboseProgressActive = deps.verboseProgressActive ?? (() => false);
  return {
    onToolStart: async (payload) => {
      const toolName = payload.name?.trim();
      const progressPromise = pushToolProgress(
        formatChannelProgressDraftLineForEntry(
          entry,
          {
            event: "tool",
            name: toolName,
            phase: payload.phase,
            args: payload.args,
          },
          payload.detailMode ? { detailMode: payload.detailMode } : undefined,
        ),
        { toolName, startImmediately: true },
      );
      if (statusReactionController && toolName) {
        await statusReactionController.setTool(toolName);
      }
      await progressPromise;
    },
    onItemEvent: async (payload) => {
      if (payload.kind === "preamble") {
        if (verboseProgressActive()) {
          return;
        }
        await pushCommentaryProgress(payload.progressText, {
          itemId: payload.itemId,
        });
        return;
      }
      await pushToolProgress(
        buildChannelProgressDraftLineForEntry(entry, {
          event: "item",
          itemId: payload.itemId,
          itemKind: payload.kind,
          title: payload.title,
          name: payload.name,
          phase: payload.phase,
          status: payload.status,
          summary: payload.summary,
          progressText: payload.progressText,
          meta: payload.meta,
        }),
      );
    },
    onPlanUpdate: async (payload) => {
      if (payload.phase !== "update") {
        return;
      }
      await pushToolProgress(
        formatChannelProgressDraftLine({
          event: "plan",
          phase: payload.phase,
          title: payload.title,
          explanation: payload.explanation,
          steps: payload.steps,
        }),
      );
    },
    onApprovalEvent: async (payload) => {
      if (payload.phase !== "requested") {
        return;
      }
      await pushToolProgress(
        formatChannelProgressDraftLine({
          event: "approval",
          phase: payload.phase,
          title: payload.title,
          command: payload.command,
          reason: payload.reason,
          message: payload.message,
        }),
      );
    },
    onCommandOutput: async (payload) => {
      if (payload.phase !== "end") {
        return;
      }
      await pushToolProgress(
        formatChannelProgressDraftLine({
          event: "command-output",
          phase: payload.phase,
          title: payload.title,
          name: payload.name,
          status: payload.status,
          exitCode: payload.exitCode,
        }),
      );
    },
    onPatchSummary: async (payload) => {
      if (payload.phase !== "end") {
        return;
      }
      await pushToolProgress(
        formatChannelProgressDraftLine({
          event: "patch",
          phase: payload.phase,
          title: payload.title,
          name: payload.name,
          added: payload.added,
          modified: payload.modified,
          deleted: payload.deleted,
          summary: payload.summary,
        }),
      );
    },
    onCompactionStart: statusReactionController
      ? async () => {
          await statusReactionController.setCompacting();
        }
      : undefined,
    onCompactionEnd: statusReactionController
      ? async () => {
          statusReactionController.cancelPending();
          await statusReactionController.setThinking();
        }
      : undefined,
  };
}
