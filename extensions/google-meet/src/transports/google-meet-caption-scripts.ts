import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

// Status observation and explicit final capture share the same line-commit owner.
export const CAPTION_LINE_COMMIT_SOURCE = `
  const captionSelf = (value) => value === true ? "self" : value === false ? "other" : "unknown";
  const captionHistoryKey = (text, ownEcho) => JSON.stringify([text, captionSelf(ownEcho)]);
  const captionObservedEcho = (entry) => entry.provenance?.self === "self" ? true : entry.provenance?.self === "other" ? false : undefined;
  const captionOriginMatches = (entry, row) => {
    if (entry.node === row.node && entry.speaker === row.speaker) return true;
    const previous = captionObservedEcho(entry);
    return previous === undefined || row.ownEcho === undefined || previous === row.ownEcho;
  };
  const captionProvenance = (state, row) => Object.freeze({
    observer: "google-meet-caption-dom",
    observationId: (state.sessionId || "unscoped") + ":" + state.epoch + ":observation:" + (state.nextObservationId = (state.nextObservationId || 0) + 1),
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    epoch: state.epoch,
    observedAt: new Date(Date.now()).toISOString(),
    ...(row.speaker ? { speaker: row.speaker } : {}),
    self: captionSelf(row.ownEcho)
  });
  const captionLine = (entry) => ({
    at: entry.at,
    speaker: entry.speaker,
    text: entry.text,
    ...(entry.source ? { source: { ...entry.source } } : {}),
    ...(entry.provenance ? { provenance: { ...entry.provenance } } : {})
  });
  const rememberCaptionSource = (state, entry) => {
    if (!entry.source || !state.sourceHistory) return;
    state.sourceRevisions?.set(entry.source.id, Math.max(state.sourceRevisions.get(entry.source.id) || 0, Number(entry.source.revision)));
    // Remember every retained native origin without weakening its sticky source authority.
    const key = captionHistoryKey(entry.text, captionObservedEcho(entry));
    if (state.sourceHistory.has(key) || state.sourceHistory.size < ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES}) {
      state.sourceHistory.set(key, { ...entry.source });
    }
  };
  const reviseCaptionSource = (state, entry, changes) => {
    if (!entry.source) return;
    const revision = Number(entry.source.revision);
    if (revision < (state.sourceRevisions?.get(entry.source.id) || 0)) {
      entry.source = undefined;
      return;
    }
    entry.source = { ...entry.source, ...changes, revision: String(revision + 1) };
  };
  const commitLines = (state, entries, stillVisible = []) => {
    state.lines = Array.isArray(state.lines) ? state.lines : [];
    const liveSources = new Set(stillVisible.flatMap((entry) => entry.source ? [entry.source.id] : []));
    for (const entry of entries) {
      if (entry.source && Number(entry.source.revision) < (state.sourceRevisions?.get(entry.source.id) || 0)) entry.source = undefined;
      if (entry.source && !entry.source.finalized && !liveSources.has(entry.source.id)) {
        reviseCaptionSource(state, entry, { finalized: true });
      }
      rememberCaptionSource(state, entry);
      state.lines.push(captionLine(entry));
    }
    const excess = state.lines.length - ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.droppedLines = (state.droppedLines || 0) + excess;
    }
  };
`;

export function meetTranscriptScript(
  meetingUrl: string,
  meetingSessionId: string,
  finalize: boolean,
) {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `() => {
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  const expectedSessionId = ${JSON.stringify(meetingSessionId)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify({ urlMatched: false });
  }
  if (!expectedMeetingUrl || currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify({ urlMatched: false });
  }
  const state = window.__openclawMeetCaptions;
  ${CAPTION_LINE_COMMIT_SOURCE}
  if (state?.sessionId && state.sessionId !== expectedSessionId) {
    return JSON.stringify({ urlMatched: true, sessionMatched: false });
  }
  if (${JSON.stringify(finalize)} && Array.isArray(state?.visible) && state.visible.length > 0) {
    if (state.settleTimer !== undefined) clearTimeout(state.settleTimer);
    state.settleTimer = undefined;
    commitLines(state, state.visible);
    state.visible = [];
  }
  const lines = Array.isArray(state?.lines) ? state.lines : [];
  return JSON.stringify({
    urlMatched: true,
    sessionMatched: true,
    epoch: typeof state?.epoch === "string" ? state.epoch : undefined,
    droppedLines: Number.isFinite(state?.droppedLines) ? Math.max(0, Math.trunc(state.droppedLines)) : 0,
    lines: lines.map((line) => ({
      at: typeof line?.at === "string" ? line.at : undefined,
      speaker: typeof line?.speaker === "string" ? line.speaker : undefined,
      text: typeof line?.text === "string" ? line.text : "",
      ...(line?.source ? { source: { ...line.source } } : {}),
      ...(line?.provenance ? { provenance: { ...line.provenance } } : {})
    })).filter((line) => line.text),
    pendingLines: (Array.isArray(state?.visible) ? state.visible : []).map(captionLine)
  });
}`;
}
