import { CAPTION_LINE_COMMIT_SOURCE } from "./google-meet-caption-scripts.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

const GOOGLE_MEET_CAPTION_SETTLE_MS = 1_000;

// Provider-local observer state; retained row provenance never supplies action authority.
export const GOOGLE_MEET_CAPTION_OBSERVER_SOURCE = `
  let captioning = false;
  let captionsEnabledAttempted = false;
  let transcriptLines = 0;
  let lastCaptionAt;
  let lastCaptionSpeaker;
  let lastCaptionText;
  let recentTranscript = [];
  const captionSelector = '[role="region"][aria-label*="aption" i], [aria-live="polite"][role="region"], div[aria-live="polite"]';
  const captionState = (() => {
    if (!captureCaptions) return undefined;
    const w = window;
    if (!inCall && !w.__openclawMeetCaptions) return undefined;
    // A reused tab starts a fresh logical transcript for each OpenClaw session.
    // Status refreshes omit the id, so they preserve the active page-owned buffer.
    if (!w.__openclawMeetCaptions || (captionSessionId && w.__openclawMeetCaptions.sessionId !== captionSessionId)) {
      if (w.__openclawMeetCaptions?.settleTimer !== undefined) {
        clearTimeout(w.__openclawMeetCaptions.settleTimer);
      }
      w.__openclawMeetCaptions?.observer?.disconnect?.();
      w.__openclawMeetCaptions = {
        sessionId: captionSessionId,
        // Epochs cross document lifetimes in the runtime transcript cursor.
        // Strong UUIDs keep a reloaded page distinct from its prior buffer.
        epoch: crypto.randomUUID(),
        enabledAttempted: false,
        observerInstalled: false,
        observer: undefined,
        droppedLines: 0,
        nextSourceId: 0,
        nextObservationId: 0,
        sourceNodes: new WeakMap(),
        sourceHistory: new Map(),
        sourceRevisions: new Map(),
        lines: [],
        settleTimer: undefined,
        visible: []
      };
    }
    return w.__openclawMeetCaptions;
  })();
  const normalizeCaption = (speaker, captionText) => {
    if (!captionState) return;
    const clean = String(captionText || "").replace(/\\s+/g, " ").trim();
    const cleanSpeaker = String(speaker || "").replace(/\\s+/g, " ").trim();
    if (!clean || clean.length < 2) return undefined;
    if (/^(turn on captions|turn off captions|captions)$/i.test(clean)) return undefined;
    return { speaker: cleanSpeaker || undefined, text: clean };
  };
  ${CAPTION_LINE_COMMIT_SOURCE}
  const captionOwnEcho = (node) => {
    const marked = node?.closest?.('[data-is-self]') || node;
    const value = marked?.getAttribute?.("data-is-self");
    return value === "true" ? true : value === "false" ? false : undefined;
  };
  const sourceForCaption = (row, continuing) => {
    // Text is only a replay lookup, never the minted identity. Keep the original
    // handle for ambiguous repeated utterances; their transcript entries remain.
    const known = captionState.sourceNodes?.get(row.node);
    const sameLifecycle = known && captionOriginMatches(known, row) && (continuing || known.text === row.text ||
      known.text.startsWith(row.text) || row.text.startsWith(known.text));
    if (sameLifecycle && !known.source) return undefined;
    if (sameLifecycle && known.text !== row.text && known.text.startsWith(row.text)) return undefined;
    const remembered = sameLifecycle ? known.source : captionState.sourceHistory?.get(captionHistoryKey(row.text, row.ownEcho));
    if (remembered) {
      if (Number(remembered.revision) < (captionState.sourceRevisions?.get(remembered.id) || 0)) return undefined;
      return sameLifecycle && known.text !== row.text
        ? { ...remembered, revision: String(Number(remembered.revision) + 1), finalized: false }
        : { ...remembered };
    }
    // Missing attribution cannot turn remembered speech into fresh authority.
    const unknown = captionState.sourceHistory?.get(captionHistoryKey(row.text, undefined));
    // A text correction does not resolve the native attribution of its older observation.
    if (unknown || (row.ownEcho === undefined && [true, false].some((self) => captionState.sourceHistory?.has(captionHistoryKey(row.text, self))))) return undefined;
    // At the replay bound, retain row provenance but do not mint new authority.
    if (!captionState.sessionId || !captionState.sourceHistory || row.text.length > 16_384 || captionState.sourceHistory.size >= ${GOOGLE_MEET_TRANSCRIPT_MAX_LINES}) return undefined;
    captionState.nextSourceId += 1;
    return {
      id: captionState.sessionId + ":" + captionState.epoch + ":" + captionState.nextSourceId,
      epoch: captionState.epoch,
      revision: "1",
      finalized: false,
      ...(row.ownEcho === undefined ? {} : { ownEcho: row.ownEcho })
    };
  };
  const scrapeCaptions = () => {
    if (!captionState) return;
    const regions = [...document.querySelectorAll(captionSelector)];
    const rows = [];
    for (const region of regions) {
      const raw = text(region);
      if (!raw) continue;
      const pieces = raw.split(/\\n+/).map((part) => part.trim()).filter(Boolean);
      const row = pieces.length >= 2
        ? normalizeCaption(pieces[0], pieces.slice(1).join(" "))
        : normalizeCaption("", pieces[0] || raw);
      if (row) rows.push({ ...row, node: region, ownEcho: captionOwnEcho(region) });
    }
    if (rows.length === 0) {
      // Meet briefly removes caption rows while rerendering. Keep them mutable
      // for one settle window so a DOM gap cannot fabricate a repeated line.
      if (captionState.visible.length > 0 && captionState.settleTimer === undefined) {
        const pendingState = captionState;
        pendingState.settleTimer = setTimeout(() => {
          if (window.__openclawMeetCaptions !== pendingState) return;
          commitLines(pendingState, pendingState.visible);
          pendingState.visible = [];
          pendingState.settleTimer = undefined;
        }, ${GOOGLE_MEET_CAPTION_SETTLE_MS});
      }
      return;
    }
    if (captionState.settleTimer !== undefined) {
      clearTimeout(captionState.settleTimer);
      captionState.settleTimer = undefined;
    }
    const previous = Array.isArray(captionState.visible) ? captionState.visible : [];
    const unmatchedPrevious = [...previous];
    const nextVisible = [];
    const retired = [];
    const now = Date.now();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const sameNodeIndex = unmatchedPrevious.findIndex((candidate) => candidate.node === row.node);
      const matchesPrior = (candidate) => {
        const sameTextLifecycle =
          candidate.text === row.text ||
          row.text.startsWith(candidate.text) ||
          candidate.text.startsWith(row.text);
        const sameDomLifecycle =
          candidate.node === row.node || now - candidate.seenAt <= ${GOOGLE_MEET_CAPTION_SETTLE_MS};
        return candidate.speaker === row.speaker && captionOriginMatches(candidate, row) && sameTextLifecycle && sameDomLifecycle;
      };
      const priorIndex = sameNodeIndex >= 0
        ? (matchesPrior(unmatchedPrevious[sameNodeIndex]) ? sameNodeIndex : -1)
        : unmatchedPrevious.findIndex(matchesPrior);
      const prior = priorIndex >= 0 ? unmatchedPrevious.splice(priorIndex, 1)[0] : undefined;
      if (prior) {
        if (prior.source && Number(prior.source.revision) < (captionState.sourceRevisions?.get(prior.source.id) || 0)) prior.source = undefined;
        // A shortening often accompanies a DOM redraw; preserve the fuller line.
        const changed = prior.text !== row.text && !prior.text.startsWith(row.text);
        const ownEcho = prior.source?.ownEcho === true || row.ownEcho === true
          ? true : prior.source?.ownEcho ?? row.ownEcho;
        if (prior.source && (changed || ownEcho !== prior.source.ownEcho)) {
          reviseCaptionSource(captionState, prior, { finalized: changed ? false : prior.source.finalized, ...(ownEcho === undefined ? {} : { ownEcho }) });
        }
        if (changed || prior.node !== row.node || prior.provenance?.self !== captionSelf(row.ownEcho)) prior.provenance = captionProvenance(captionState, row);
        if (changed) prior.text = row.text;
        prior.node = row.node;
        prior.seenAt = now;
        captionState.sourceNodes?.set(row.node, prior);
        rememberCaptionSource(captionState, prior);
        nextVisible.push(prior);
        continue;
      }
      // Keep the transcript's existing non-prefix line boundary, while a reused
      // live DOM row cannot turn a correction into a fresh participation source.
      const continuingIndex = unmatchedPrevious.findIndex((candidate) => candidate.node === row.node);
      const continuing = continuingIndex >= 0 ? unmatchedPrevious.splice(continuingIndex, 1)[0] : undefined;
      if (continuing) retired.push(continuing);
      const entry = {
        at: new Date().toISOString(),
        node: row.node,
        seenAt: now,
        speaker: row.speaker,
        text: row.text,
        source: sourceForCaption(row, Boolean(continuing)),
        provenance: captionProvenance(captionState, row)
      };
      const ownEcho = entry.source?.ownEcho === true || row.ownEcho === true
        ? true : entry.source?.ownEcho ?? row.ownEcho;
      if (entry.source && ownEcho !== entry.source.ownEcho) {
        reviseCaptionSource(captionState, entry, { ownEcho });
      }
      captionState.sourceNodes?.set(row.node, entry);
      rememberCaptionSource(captionState, entry);
      nextVisible.push(entry);
    }
    commitLines(captionState, [...retired, ...unmatchedPrevious], nextVisible);
    captionState.visible = nextVisible;
  };
  if (captionState) {
    if (!readOnly && inCall && !captionState.enabledAttempted) {
      const captionButton = findButton(/turn on captions|show captions|captions/i);
      const captionLabel = captionButton ? (captionButton.getAttribute("aria-label") || captionButton.getAttribute("data-tooltip") || text(captionButton)) : "";
      if (captionButton) {
        captionState.enabledAttempted = true;
        captionsEnabledAttempted = true;
        if (!/turn off captions|hide captions/i.test(captionLabel)) {
          captionButton.click();
          notes.push("Attempted to enable Meet captions for observe-only transcript health.");
        }
      }
    } else if (captionState.enabledAttempted) {
      captionsEnabledAttempted = true;
    }
    if (inCall && !captionState.observerInstalled) {
      captionState.observerInstalled = true;
      captionState.observer = new MutationObserver(scrapeCaptions);
      captionState.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-is-self"]
      });
      notes.push("Installed Meet caption observer for observe-only transcript health.");
    }
    if (inCall) {
      scrapeCaptions();
    }
    const committedLines = Array.isArray(captionState.lines) ? captionState.lines : [];
    const visibleLines = Array.isArray(captionState.visible) ? captionState.visible : [];
    const lines = [...committedLines, ...visibleLines];
    const last = lines[lines.length - 1];
    captioning = document.querySelector(captionSelector) !== null || lines.length > 0;
    transcriptLines = (captionState.droppedLines || 0) + lines.length;
    lastCaptionAt = last?.at;
    lastCaptionSpeaker = last?.speaker;
    lastCaptionText = last?.text;
    recentTranscript = lines.slice(-5).map(captionLine);
  }
`;
