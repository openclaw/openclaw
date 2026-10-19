import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";
import { formatMatrixMessageText, resolveMatrixReplacementContent } from "../media-text.js";
import {
  formatPollAsText,
  isPollStartType,
  parsePollStart,
  type PollStartContent,
} from "../poll-types.js";
import type { MatrixRawEvent } from "./types.js";

const MAX_CONTEXT_BODY_LENGTH = 500;

export function truncateMatrixContextBody(value: string): string {
  return truncateWithMarker(value, MAX_CONTEXT_BODY_LENGTH, {
    marker: "...",
    reserve: 3,
    trimEnd: false,
  });
}

export function summarizeMatrixMessageContextEvent(event: MatrixRawEvent): string | undefined {
  if (isPollStartType(event.type)) {
    const pollSummary = parsePollStart(event.content as PollStartContent);
    if (pollSummary) {
      return formatPollAsText(pollSummary);
    }
  }

  const content = (resolveMatrixReplacementContent(event) ?? event.content) as {
    body?: unknown;
    filename?: unknown;
    msgtype?: unknown;
  };
  return formatMatrixMessageText({
    body: readStringValue(content.body),
    filename: readStringValue(content.filename),
    msgtype: normalizeOptionalString(content.msgtype),
  });
}
