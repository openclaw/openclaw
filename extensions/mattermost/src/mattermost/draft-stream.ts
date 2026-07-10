// Mattermost plugin module implements draft stream behavior.
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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
  forceNewMessage: () => Promise<void>;
};

function normalizeMattermostDraftText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${sliceUtf16Safe(trimmed, 0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export type MattermostDraftPreviewBoundaryController = {
  noteUpdate: () => void;
  noteBoundary: () => Promise<void>;
};

export function createMattermostDraftPreviewBoundaryController(params: {
  enabled: boolean;
  forceNewMessage: () => void | Promise<void>;
}): MattermostDraftPreviewBoundaryController {
  let hasStreamedContent = false;
  return {
    noteUpdate() {
      hasStreamedContent = true;
    },
    async noteBoundary() {
      if (!params.enabled) {
        return;
      }
      if (!hasStreamedContent) {
        return;
      }
      hasStreamedContent = false;
      await params.forceNewMessage();
    },
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
  type DraftGeneration = {
    postId?: string;
    lastSentText: string;
    ready: Promise<void>;
  };
  let currentGeneration: DraftGeneration = {
    lastSentText: "",
    ready: Promise.resolve(),
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const rendered = params.renderText?.(text) ?? text;
    const normalized = normalizeMattermostDraftText(rendered, maxChars);
    if (!normalized) {
      return false;
    }
    const target = currentGeneration;
    await target.ready;
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    if (normalized === target.lastSentText) {
      return true;
    }
    try {
      if (target.postId) {
        await updateMattermostPost(params.client, target.postId, {
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
        target.postId = postId;
      }
      target.lastSentText = normalized;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const clearMessageId = () => {
    currentGeneration.postId = undefined;
  };
  const isValidMessageId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  const deleteMessage = async (postId: string) => {
    await deleteMattermostPost(params.client, postId);
  };
  const {
    loop,
    update,
    stop: stopLifecycle,
    stopForClear,
    seal: sealLifecycle,
  } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => currentGeneration.postId,
    clearMessageId,
    isValidMessageId,
    deleteMessage,
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    if (streamState.stopped || streamState.final) {
      return Promise.resolve();
    }
    // Agent boundary callbacks are fire-and-forget. Swap generations synchronously; the new
    // generation waits for the old send and seal so posts stay in publication order.
    const sealText = loop.takePending();
    const inFlightAtBoundary = loop.waitForInFlight();
    const sealed = currentGeneration;
    const boundary = (async () => {
      try {
        await sealed.ready;
        await inFlightAtBoundary;
        if (!sealText.trim() || (streamState.stopped && !streamState.final)) {
          return;
        }
        const rendered = params.renderText?.(sealText) ?? sealText;
        const normalized = normalizeMattermostDraftText(rendered, maxChars);
        if (!normalized || normalized === sealed.lastSentText) {
          return;
        }
        if (sealed.postId) {
          await updateMattermostPost(params.client, sealed.postId, { message: normalized });
        } else {
          await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: normalized,
            rootId: params.rootId,
          });
        }
      } catch (err) {
        params.warn?.(
          `mattermost stream preview boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    currentGeneration = { lastSentText: "", ready: boundary };
    loop.resetThrottleWindow();
    return boundary;
  };

  const flush = async () => {
    await loop.flush();
    await currentGeneration.ready;
  };
  const discardPending = async () => {
    await stopForClear();
    await currentGeneration.ready;
  };
  const clear = async () => {
    await clearFinalizableDraftMessage({
      stopForClear: discardPending,
      readMessageId: () => currentGeneration.postId,
      clearMessageId,
      isValidMessageId,
      deleteMessage,
      warn: params.warn,
      warnPrefix: "mattermost stream preview cleanup failed",
    });
  };
  const seal = async () => {
    await sealLifecycle();
    await currentGeneration.ready;
  };
  const stop = async () => {
    await stopLifecycle();
    await currentGeneration.ready;
  };

  params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush,
    postId: () => currentGeneration.postId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
  };
}
