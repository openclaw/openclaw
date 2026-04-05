import { formatTrimmedAllowFromEntries } from "mullusi/plugin-sdk/channel-config-helpers";
import type { ChannelStatusIssue } from "mullusi/plugin-sdk/channel-contract";
import { PAIRING_APPROVED_MESSAGE } from "mullusi/plugin-sdk/channel-status";
import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
  type MullusiConfig,
} from "mullusi/plugin-sdk/core";
import { resolveChannelMediaMaxBytes } from "mullusi/plugin-sdk/media-runtime";
import { collectStatusIssuesFromLastError } from "mullusi/plugin-sdk/status-helpers";
import {
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./config-accessors.js";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./normalize.js";

export {
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
};

export type { ChannelPlugin, ChannelStatusIssue, MullusiConfig };

export function chunkTextForOutbound(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const splitAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const breakAt = splitAt > 0 ? splitAt : limit;
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0 || text.length === 0) {
    chunks.push(remaining);
  }
  return chunks;
}
