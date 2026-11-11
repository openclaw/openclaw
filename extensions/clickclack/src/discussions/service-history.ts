import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ClickClackClient } from "../http-client.js";
import type { CoreConfig } from "../types.js";
import type {
  ClickClackDiscussionBinding,
  ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { resolveDiscussionBindingAccount } from "./eligibility.js";
import { prepareClickClackDiscussionChannelRevocation } from "./revoked-channel-store.js";
import { prepareDiscussionSessionEntry } from "./session-authority.js";

// JSON-escape plus Unicode line separators so one history record stays one line.
function discussionRecordJson(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/gu,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Renders channel history as line-per-message records for the discussion tool. */
function formatDiscussionHistory(
  history: Awaited<ReturnType<ClickClackClient["latestChannelMessages"]>>,
): string {
  const text = history.messages
    .map((message) => {
      const author =
        message.author?.display_name || message.author?.handle || message.author_id || "Unknown";
      return `timestamp=${discussionRecordJson(message.created_at)} [Author ${discussionRecordJson(author)} id=${discussionRecordJson(message.author_id)}] text=${discussionRecordJson(message.body)}`;
    })
    .join("\n");
  const truncationNote = history.truncated
    ? "\n[History scan reached its safety bound; older active threads may be omitted.]"
    : "";
  return text ? `${text}${truncationNote}` : "";
}

export async function readDiscussionHistory(params: {
  runtime: PluginRuntime;
  store: ClickClackDiscussionBindingStore;
  sessionKey: string;
  binding: ClickClackDiscussionBinding;
  client: ClickClackClient;
  limit: number;
}): Promise<{ binding?: ClickClackDiscussionBinding; text: string }> {
  const { runtime, store, sessionKey, binding, client, limit } = params;
  const bindingFacts = await store.prepareRead(sessionKey);
  let revocation:
    | Awaited<ReturnType<typeof prepareClickClackDiscussionChannelRevocation>>
    | undefined;
  let session: Awaited<ReturnType<typeof prepareDiscussionSessionEntry>> | undefined;
  try {
    const channelRevocation = await prepareClickClackDiscussionChannelRevocation({
      runtime,
      ...binding,
    });
    revocation = channelRevocation;
    const sessionEntry = await prepareDiscussionSessionEntry(runtime, sessionKey);
    session = sessionEntry;
    const canReadHistory = () => {
      try {
        sessionEntry.source();
        const current = bindingFacts.read();
        // SAFETY: account resolution only reads the SDK's schema-validated configuration.
        const config = runtime.config.current() as CoreConfig;
        return (
          current !== undefined &&
          current.externalRef === binding.externalRef &&
          current.serverBaseUrl === binding.serverBaseUrl &&
          current.channelId === binding.channelId &&
          sessionEntry.entry?.sessionId === binding.sessionId &&
          sessionEntry.entry.archivedAt === undefined &&
          resolveDiscussionBindingAccount(config, binding).state === "active" &&
          !channelRevocation.isRevoked(current)
        );
      } catch {
        return false;
      }
    };
    // The credentialed fetch and the later disclosure each require current authority.
    if (!canReadHistory()) {
      return { text: "No discussion is bound to this session." };
    }
    const history = await client.latestChannelMessages(binding.channelId, limit);
    if (!canReadHistory()) {
      return { text: "No discussion is bound to this session." };
    }
    return {
      binding,
      text: formatDiscussionHistory(history) || "The bound discussion has no messages yet.",
    };
  } finally {
    session?.release();
    revocation?.release();
    bindingFacts.release();
  }
}
