import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createMattermostPost,
  deleteMattermostPost,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MATTERMOST_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;

export type MattermostDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => void;
};

export function normalizeMattermostDraftText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

const TOOL_STATUS_VERBS: Record<string, string> = {
  exec: "Running command",
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  message: "Sending message",
  web_fetch: "Fetching web page",
  browser: "Browsing",
  canvas: "Updating canvas",
  tts: "Generating speech",
  process: "Managing process",
  lcm_grep: "Searching memory",
  lcm_describe: "Inspecting memory",
  lcm_expand: "Expanding memory",
  lcm_expand_query: "Recalling memory",
  memory_search: "Searching notes",
  memory_get: "Reading notes",
  sessions_spawn: "Spawning sub-agent",
  sessions_send: "Messaging session",
  sessions_list: "Listing sessions",
  sessions_history: "Reading session history",
  subagents: "Managing sub-agents",
  session_status: "Checking status",
};

export function buildMattermostToolStatusText(params: {
  name?: string;
  phase?: string;
  title?: string;
}): string {
  const name = params.name?.trim();
  const title = params.title?.trim();
  if (!name) return "Running tool…";
  const verb = TOOL_STATUS_VERBS[name] ?? "Running";
  // If runtime supplied a richer title (e.g. "exec(ls *.md)"), surface it.
  if (title && title !== name) return `${verb} \`${name}\` — ${title}…`;
  return `${verb} \`${name}\`…`;
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
