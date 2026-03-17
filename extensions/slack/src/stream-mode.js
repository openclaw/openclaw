import {
  mapStreamingModeToSlackLegacyDraftStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode
} from "../../../src/config/discord-preview-streaming.js";
const DEFAULT_STREAM_MODE = "replace";
function resolveSlackStreamMode(raw) {
  if (typeof raw !== "string") {
    return DEFAULT_STREAM_MODE;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
    return normalized;
  }
  return DEFAULT_STREAM_MODE;
}
function resolveSlackStreamingConfig(params) {
  const mode = resolveSlackStreamingMode(params);
  const nativeStreaming = resolveSlackNativeStreaming(params);
  return {
    mode,
    nativeStreaming,
    draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode)
  };
}
function applyAppendOnlyStreamUpdate(params) {
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
  if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) {
    return { rendered: incoming, source: incoming, changed: incoming !== params.rendered };
  }
  if (params.source.startsWith(incoming)) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }
  const separator = params.rendered.endsWith("\n") ? "" : "\n";
  return {
    rendered: `${params.rendered}${separator}${incoming}`,
    source: incoming,
    changed: true
  };
}
function buildStatusFinalPreviewText(updateCount) {
  const dots = ".".repeat(Math.max(1, updateCount) % 3 + 1);
  return `Status: thinking${dots}`;
}
export {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamMode,
  resolveSlackStreamingConfig
};
