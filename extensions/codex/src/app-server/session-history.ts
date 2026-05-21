import fs from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

const OPENCLAW_RUNTIME_CONTEXT_MARKER = "OpenClaw runtime context for this turn:";
const CURRENT_USER_REQUEST_MARKER = "\nCurrent user request:\n";
const OMITTED_OPENCLAW_CONTEXT_TEXT = "omitted stale OpenClaw runtime context from prior user turn";

export type CodexMirroredSessionHistoryReadResult = {
  messages: AgentMessage[];
  sanitizedRuntimeContextUserMessages: number;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

export async function readCodexMirroredSessionHistoryMessages(
  sessionFile: string,
): Promise<AgentMessage[] | undefined> {
  return (await readCodexMirroredSessionHistory(sessionFile))?.messages;
}

export async function readCodexMirroredSessionHistory(
  sessionFile: string,
): Promise<CodexMirroredSessionHistoryReadResult | undefined> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const entries = parseSessionEntries(raw);
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
      return undefined;
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter(
      (entry): entry is SessionEntry => entry.type !== "session",
    );
    const sanitized = sanitizeCodexRuntimeContextHistoryMessages(
      buildSessionContext(sessionEntries).messages,
    );
    return {
      messages: sanitizeCodexHistoryImagePayloads(sanitized.messages, "codex mirrored history"),
      sanitizedRuntimeContextUserMessages: sanitized.sanitizedRuntimeContextUserMessages,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { messages: [], sanitizedRuntimeContextUserMessages: 0 };
    }
    return undefined;
  }
}

export function sanitizeCodexRuntimeContextHistoryMessages(messages: AgentMessage[]): {
  messages: AgentMessage[];
  sanitizedRuntimeContextUserMessages: number;
} {
  let sanitizedRuntimeContextUserMessages = 0;
  const sanitizedMessages = messages.map((message) => {
    if (message.role !== "user" || !("content" in message)) {
      return message;
    }
    const sanitized = sanitizeCodexRuntimeContextHistoryContent(
      message.content,
      "codex mirrored history",
    );
    if (!sanitized.changed) {
      return message;
    }
    sanitizedRuntimeContextUserMessages += 1;
    return { ...message, content: sanitized.content } as AgentMessage;
  });
  return { messages: sanitizedMessages, sanitizedRuntimeContextUserMessages };
}

function sanitizeCodexRuntimeContextHistoryContent(
  content: unknown,
  label: string,
): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    const sanitized = sanitizeCodexRuntimeContextHistoryText(content, label);
    return sanitized.changed
      ? { content: sanitized.text, changed: true }
      : { content, changed: false };
  }
  if (!Array.isArray(content)) {
    return { content, changed: false };
  }

  let changed = false;
  const nextContent = content.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !("text" in entry) ||
      typeof entry.text !== "string"
    ) {
      return entry;
    }
    const sanitized = sanitizeCodexRuntimeContextHistoryText(entry.text, label);
    if (!sanitized.changed) {
      return entry;
    }
    changed = true;
    return { ...entry, text: sanitized.text };
  });

  return changed ? { content: nextContent, changed: true } : { content, changed: false };
}

function sanitizeCodexRuntimeContextHistoryText(
  text: string,
  label: string,
): { text: string; changed: boolean } {
  if (!text.includes(OPENCLAW_RUNTIME_CONTEXT_MARKER)) {
    return { text, changed: false };
  }
  const markerIndex = text.lastIndexOf(CURRENT_USER_REQUEST_MARKER);
  if (markerIndex >= 0) {
    const userRequest = text.slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length).trimStart();
    if (userRequest.trim()) {
      return { text: userRequest, changed: true };
    }
  }
  return { text: `[${label}] ${OMITTED_OPENCLAW_CONTEXT_TEXT}`, changed: true };
}
