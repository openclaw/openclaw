import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createMattermostPost,
  deleteMattermostPost,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MATTERMOST_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;

type MattermostDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
};

function normalizeMattermostDraftText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildMattermostToolStatusText(params: { name?: string; phase?: string }): string {
  const tool = params.name?.trim() ? ` \`${params.name.trim()}\`` : " tool";
  return `Running${tool}…`;
}

/**
 * Boundary controller for the Mattermost draft preview stream.
 *
 * In `"partial"` mode (the historical default) the draft preview lives in a
 * single post that is edited in place across the whole turn. Every transition
 * — thinking → partial reply → tool status → next partial reply — overwrites
 * the same post, which causes prior content to disappear from the user's
 * view at every transition.
 *
 * In `"block"` mode this controller is wired into the lifecycle hooks so
 * that at each turn boundary (assistant-message start, reasoning end, tool
 * start) `forceNewMessage()` is called on the underlying draft stream. That
 * leaves the previous post frozen in the channel and starts a fresh post
 * for the next chunk, so prior content stays visible.
 *
 * `markStreamedContent()` must be called whenever the caller pushes content
 * into the draft stream that is user-visible. Boundary calls only fire
 * `forceNewMessage()` when there is something to split off, otherwise the
 * boundary is a no-op (we never want to leave behind an empty preview post).
 */
export type MattermostDraftPreviewBoundaryController = {
  /** Mark that user-visible content has just been pushed to the stream. */
  markStreamedContent: () => void;
  /**
   * Signal a turn boundary. In "block" mode and only when there is unsplit
   * streamed content, calls `forceNewMessage()` on the underlying stream.
   * Returns true if the boundary triggered an actual split.
   */
  signalBoundary: () => boolean;
  /** Whether the controller is currently splitting at boundaries. */
  isSplittingAtBoundaries: () => boolean;
};

export function createMattermostDraftPreviewBoundaryController(params: {
  draftStream: Pick<MattermostDraftStream, "forceNewMessage">;
  /** When true, boundary calls trigger forceNewMessage(). */
  splitAtBoundaries: boolean;
  /**
   * Optional reset hook invoked after a successful split so the caller can
   * reset any per-post state (e.g. cached partial text it dedupes against).
   */
  onSplit?: () => void;
}): MattermostDraftPreviewBoundaryController {
  let hasStreamedContentSinceBoundary = false;
  return {
    markStreamedContent: () => {
      hasStreamedContentSinceBoundary = true;
    },
    signalBoundary: () => {
      if (!params.splitAtBoundaries) {
        return false;
      }
      if (!hasStreamedContentSinceBoundary) {
        return false;
      }
      params.draftStream.forceNewMessage();
      hasStreamedContentSinceBoundary = false;
      params.onSplit?.();
      return true;
    },
    isSplittingAtBoundaries: () => params.splitAtBoundaries,
  };
}

export function createMattermostDraftStream(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  maxChars?: number;
  throttleMs?: number;
  renderText?: (text: string) => string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): MattermostDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? MATTERMOST_STREAM_MAX_CHARS,
    MATTERMOST_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const streamState = { stopped: false, final: false };
  let streamPostId: string | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const rendered = params.renderText?.(text) ?? text;
    const normalized = normalizeMattermostDraftText(rendered, maxChars);
    if (!normalized) {
      return false;
    }
    if (normalized === lastSentText) {
      return true;
    }
    try {
      if (streamPostId) {
        await updateMattermostPost(params.client, streamPostId, {
          message: normalized,
        });
      } else {
        const sent = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message: normalized,
          rootId: params.rootId,
        });
        const postId = sent.id?.trim();
        if (!postId) {
          streamState.stopped = true;
          params.warn?.("mattermost stream preview stopped (missing post id from create)");
          return false;
        }
        streamPostId = postId;
      }
      lastSentText = normalized;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => streamPostId,
    clearMessageId: () => {
      streamPostId = undefined;
    },
    isValidMessageId: (value): value is string => typeof value === "string" && value.length > 0,
    deleteMessage: async (postId) => {
      await deleteMattermostPost(params.client, postId);
    },
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamPostId = undefined;
    lastSentText = "";
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    postId: () => streamPostId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
  };
}
