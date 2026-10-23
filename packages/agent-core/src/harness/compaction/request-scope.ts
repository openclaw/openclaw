import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import {
  findLatestCompactionUserMessage,
  formatFileOperations,
  getCompactionContent,
} from "./utils.js";

export const MAX_LATEST_USER_REQUEST_CHARS = 800;
const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";

function extractLatestCompactionUserRequest(messages: AgentMessage[]): string | undefined {
  const message = findLatestCompactionUserMessage(
    messages,
    (candidate) => getCompactionContent(candidate.content).text,
  );
  const source = message ? getCompactionContent(message.content).text.trim() : "";
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

export function resolveCompactionRequestMessages(params: {
  entries: SessionTreeEntry[];
  contextMessages: AgentMessage[];
  requestEntryId?: string;
  project: (entry: SessionTreeEntry) => AgentMessage | undefined;
}): AgentMessage[] | undefined {
  if (!params.requestEntryId) {
    const latestInput = params.contextMessages.findLast((message) => message.role === "user");
    return latestInput ? [latestInput] : [];
  }
  const admittedIndex = params.entries.findIndex((entry) => entry.id === params.requestEntryId);
  const admittedEntry = params.entries[admittedIndex];
  if (!admittedEntry || params.project(admittedEntry)?.role !== "user") {
    return undefined;
  }
  return params.entries.slice(admittedIndex).flatMap((entry) => {
    const message = params.project(entry);
    return message ? [message] : [];
  });
}

export function resolveLatestCompactionUserRequest(params: {
  requestState?: "unresolved" | "none";
  requestMessages: AgentMessage[];
  previous?: string;
}): string | undefined {
  if (params.requestState !== "unresolved") {
    return undefined;
  }
  return (
    extractLatestCompactionUserRequest(params.requestMessages) ??
    (params.requestMessages.some((message) => message.role === "user")
      ? undefined
      : params.previous)
  );
}

export function stripPreviousCompactionMetadata(
  summary: string | undefined,
  details:
    | { readFiles: string[]; modifiedFiles: string[]; latestUnresolvedUserRequest?: string }
    | undefined,
): string | undefined {
  const section = details?.latestUnresolvedUserRequest
    ? `## Latest unresolved user request\n${JSON.stringify(details.latestUnresolvedUserRequest)}\n\n`
    : "";
  const withoutRequest =
    section && summary?.includes(section) ? summary.replace(section, "") : summary;
  const fileOperations = details
    ? formatFileOperations(details.readFiles, details.modifiedFiles)
    : "";
  return fileOperations && withoutRequest?.endsWith(fileOperations)
    ? withoutRequest.slice(0, -fileOperations.length)
    : withoutRequest;
}
