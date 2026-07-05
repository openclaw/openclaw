// Slack plugin module implements stream mode behavior.
<<<<<<< HEAD
=======
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  mapStreamingModeToSlackLegacyDraftStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  type SlackLegacyDraftStreamMode,
  type StreamingMode,
} from "./streaming-compat.js";

<<<<<<< HEAD
type SlackStreamingMode = StreamingMode;
=======
type SlackStreamMode = SlackLegacyDraftStreamMode;
type SlackStreamingMode = StreamingMode;
const DEFAULT_STREAM_MODE: SlackStreamMode = "replace";

export function resolveSlackStreamMode(raw: unknown): SlackStreamMode {
  if (typeof raw !== "string") {
    return DEFAULT_STREAM_MODE;
  }
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
    return normalized;
  }
  return DEFAULT_STREAM_MODE;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export function resolveSlackStreamingConfig(params: {
  streaming?: unknown;
  streamMode?: unknown;
  nativeStreaming?: unknown;
<<<<<<< HEAD
}): {
  mode: SlackStreamingMode;
  nativeStreaming: boolean;
  draftMode: SlackLegacyDraftStreamMode;
} {
=======
}): { mode: SlackStreamingMode; nativeStreaming: boolean; draftMode: SlackStreamMode } {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const mode = resolveSlackStreamingMode(params);
  const nativeStreaming = resolveSlackNativeStreaming(params);
  return {
    mode,
    nativeStreaming,
    draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode),
  };
}

export function applyAppendOnlyStreamUpdate(params: {
  incoming: string;
  rendered: string;
  source: string;
}): { rendered: string; source: string; changed: boolean } {
  const incoming = params.incoming.trimEnd();
  if (!incoming) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }
  if (!params.rendered) {
    return { rendered: incoming, source: incoming, changed: true };
  }
  if (incoming === params.source) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }

  // Typical model partials are cumulative prefixes.
  if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) {
    return { rendered: incoming, source: incoming, changed: incoming !== params.rendered };
  }

  // Ignore regressive shorter variants of the same stream.
  if (params.source.startsWith(incoming)) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }

  const separator = params.rendered.endsWith("\n") ? "" : "\n";
  return {
    rendered: `${params.rendered}${separator}${incoming}`,
    source: incoming,
    changed: true,
  };
}
<<<<<<< HEAD
=======

export function buildStatusFinalPreviewText(updateCount: number): string {
  const dots = ".".repeat((Math.max(1, updateCount) % 3) + 1);
  return `Status: thinking${dots}`;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
