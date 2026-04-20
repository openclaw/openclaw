import { updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { formatAgentInternalEventsForPrompt } from "../internal-events.js";
import { hasInternalRuntimeContext } from "../internal-runtime-context.js";
import type { AgentCommandOpts } from "./types.js";

export type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  clearedFields?: string[];
};

function preserveLatestLastInteractionAt(
  existing: SessionEntry | undefined,
  next: SessionEntry,
): SessionEntry {
  const existingLastInteractionAt = existing?.lastInteractionAt;
  if (existingLastInteractionAt == null) {
    return next;
  }
  if (next.lastInteractionAt == null || existingLastInteractionAt > next.lastInteractionAt) {
    return {
      ...next,
      lastInteractionAt: existingLastInteractionAt,
    };
  }
  return next;
}

export async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  const persisted = await updateSessionStore(params.storePath, (store) => {
    const merged = preserveLatestLastInteractionAt(
      store[params.sessionKey],
      mergeSessionEntry(store[params.sessionKey], params.entry),
    );
    for (const field of params.clearedFields ?? []) {
      if (!Object.hasOwn(params.entry, field)) {
        Reflect.deleteProperty(merged, field);
      }
    }
    store[params.sessionKey] = merged;
    return merged;
  });
  params.sessionStore[params.sessionKey] = persisted;
}

export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}
