import {
  getSessionEntryByIdAsync,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import type { CodexAppServerAuthProfileLookup } from "./app-server/auth-profile.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./app-server/shared-client.js";
import { projectBoundedCodexVisibleSessionHistory } from "./app-server/transcript-history-projection.js";
import type { CodexAppServerConversationBindingData } from "./conversation-binding-data.js";

export async function projectConversationSourceHistory(
  source: NonNullable<CodexAppServerConversationBindingData["source"]>,
  target: { threadId: string; clientId?: string },
  config: CodexAppServerAuthProfileLookup["config"],
  assertCurrent: () => Promise<void>,
): Promise<void> {
  const storePath =
    source.storePath ?? resolveStorePath(config?.session?.store, { agentId: source.agentId });
  const sessionKey =
    source.sessionKey ??
    (
      await getSessionEntryByIdAsync({
        agentId: source.agentId,
        sessionId: source.sessionId,
        storePath,
      })
    )?.sessionKey;
  if (!sessionKey) {
    return;
  }
  // Local visible transcripts remain readable for ephemeral and paginated
  // Codex threads, both of which reject native includeTurns history reads.
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: source.agentId,
    sessionId: source.sessionId,
    sessionKey,
    storePath,
  });
  const history = projectBoundedCodexVisibleSessionHistory(entries);
  if (history.length === 0) {
    return;
  }
  const clientLease = await retainSharedCodexAppServerClientByInstanceId(target.clientId);
  if (!clientLease) {
    throw new Error("Codex conversation source history lost its bound client owner.");
  }
  try {
    await clientLease.client.request(
      "thread/inject_items",
      { threadId: target.threadId, items: history },
      {
        withCurrent: async (write) => {
          await assertCurrent();
          write();
        },
      },
    );
  } finally {
    await clientLease.release();
  }
}
