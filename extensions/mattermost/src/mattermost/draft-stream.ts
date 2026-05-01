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

/**
 * Hard upper bound on how much of an args summary we'll embed in a single
 * Mattermost preview post. The summary is rendered inside a fenced code
 * block, so we can comfortably show much more than the old inline limit -
 * but we still cap to avoid pasting megabytes of structured tool input into
 * a chat post.
 */
const MATTERMOST_TOOL_ARGS_MAX_CHARS = 4000;

function summarizeMattermostToolArgValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort summary of a tool's args object for display in a preview
 * post. Returns a multi-line string suitable for embedding in a fenced code
 * block. Common single-arg shapes (command/path/input/text) come out as the
 * raw value; multi-arg shapes are rendered as `key=value` lines.
 */
export function summarizeMattermostToolArgs(
  args: Record<string, unknown> | undefined,
  options: { maxChars?: number } = {},
): string | undefined {
  if (!args) {
    return undefined;
  }
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  const maxChars = Math.max(40, options.maxChars ?? MATTERMOST_TOOL_ARGS_MAX_CHARS);
  let body: string;
  if (entries.length === 1) {
    const [key, value] = entries[0];
    const summarized = summarizeMattermostToolArgValue(value);
    if (summarized === undefined) {
      return undefined;
    }
    if (key === "command" || key === "path" || key === "input" || key === "text") {
      body = summarized;
    } else {
      body = `${key}=${summarized}`;
    }
  } else {
    const lines: string[] = [];
    for (const [key, value] of entries) {
      const summarized = summarizeMattermostToolArgValue(value);
      if (summarized === undefined) {
        continue;
      }
      // For multi-arg payloads keep each key/value on its own line so the
      // user can scan them without horizontal wrapping.
      lines.push(`${key}=${summarized}`);
    }
    if (lines.length === 0) {
      return undefined;
    }
    body = lines.join("\n");
  }
  // Trim trailing whitespace but keep newlines inside the body.
  body = body.replace(/[\u0020\t]+$/gmu, "").replace(/^\s+|\s+$/gu, "");
  if (!body) {
    return undefined;
  }
  if (body.length > maxChars) {
    return `${body.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return body;
}

/**
 * Pick a Mattermost code-fence info string ID-style hint based on the tool
 * name so the preview post gets at least best-effort syntax highlighting.
 */
function resolveMattermostToolCodeFenceLanguage(toolName?: string): string {
  const normalized = toolName?.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "exec" || normalized === "shell" || normalized.endsWith("_exec")) {
    return "bash";
  }
  return "";
}

export function buildMattermostToolStatusText(params: {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
}): string {
  const tool = params.name?.trim() ? ` \`${params.name.trim()}\`` : " tool";
  const summary = summarizeMattermostToolArgs(params.args);
  if (summary) {
    const language = resolveMattermostToolCodeFenceLanguage(params.name);
    // Use a fenced code block on its own line so the full args are visible
    // even when they span multiple lines (e.g. heredocs, multi-line shell
    // commands, or large structured inputs). Mattermost renders the fenced
    // block monospaced and preserves whitespace, which is what we want for
    // commands and file paths.
    return `Running${tool}\n\`\`\`${language}\n${summary}\n\`\`\``;
  }
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
