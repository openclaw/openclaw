import type { MeetingParticipationSource } from "openclaw/plugin-sdk/meeting-runtime";
import { meetParticipationSourceCheck } from "./google-meet-source-check.js";
import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";

type MeetChatPageRequest = {
  meetingSessionId: string;
  meetingUrl: string;
};

// The join owner installs this marker even in observe-only mode. Chat never
// adopts a tab or changes its session ownership.
function meetChatPrelude(params: MeetChatPageRequest): string {
  return `
  const expectedSessionId = ${JSON.stringify(params.meetingSessionId)};
  const expectedMeetingUrl = ${JSON.stringify(normalizeMeetUrlForReuse(params.meetingUrl))};
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const label = (node) => node.getAttribute("aria-label") || text(node);
  const current = () => {
    let url;
    try {
      const parsed = new URL(location.href);
      url = parsed.origin + parsed.pathname.toLowerCase().replace(/[/]$/, "");
    } catch { return false; }
    return Boolean(expectedMeetingUrl && url === expectedMeetingUrl &&
      window.__openclawMeetAudioSession === expectedSessionId &&
      [...document.querySelectorAll("button")].some((node) => /leave call/i.test(label(node))));
  };
  if (!current()) {
    if (window.__openclawMeetAudioSession === expectedSessionId && window.__openclawMeetChat?.sessionId === expectedSessionId) window.__openclawMeetChat.disconnected = true;
    return JSON.stringify({ status: "rejected", message: "This session no longer owns an active Meet tab." });
  }
  if (window.__openclawMeetChat?.sessionId !== expectedSessionId || window.__openclawMeetChat.disconnected) {
    window.__openclawMeetChat = {
      sessionId: expectedSessionId,
      attempts: new Map(),
    };
  }
  const state = window.__openclawMeetChat;
  const owns = () => {
    if (!current() || window.__openclawMeetChat !== state) state.disconnected = true;
    return !state.disconnected;
  };
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return node.isConnected && rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
  };
  const composers = () => [...document.querySelectorAll(
    'textarea[aria-label="Send a message"],textarea[placeholder="Send a message"],[role="textbox"][aria-label="Send a message"]'
  )].filter(visible);
  const enabled = (node) => !node.disabled && !node.readOnly && node.getAttribute("aria-disabled") !== "true" && node.getAttribute("aria-readonly") !== "true";
  const openChat = async () => {
    if (composers().length) return true;
    const toggles = [...document.querySelectorAll("button[aria-label]")].filter((node) =>
      visible(node) && /^(Chat with everyone|In-call messages)(?=$|[\\s(:,.—–-])/i.test(label(node)));
    if (toggles.length !== 1 || !enabled(toggles[0])) return false;
    const toggle = toggles[0];
    if (toggle.getAttribute("aria-pressed") !== "true" && toggle.getAttribute("aria-expanded") !== "true") {
      if (!owns()) return false;
      toggle.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return owns();
  };
  `;
}

/** The host revalidates source and session authority after panel preparation. */
export function meetPrepareChatScript(params: MeetChatPageRequest): string {
  return `async () => {${meetChatPrelude(params)}
  if (!await openChat() || !owns()) return JSON.stringify({ status: "rejected", message: "Meet chat is unavailable for the current session." });
  return JSON.stringify({ status: "prepared" });
}`;
}

/** Native Meet rows, observed with two separate participant devices. */
export function meetReadChatScript(params: MeetChatPageRequest): string {
  return `async () => {${meetChatPrelude(params)}
  // Current Meet native IDs use an empirically verified microsecond creation
  // timestamp. Keep one cutoff even when opening/loading the panel takes time;
  // delayed history must not become a fresh participant request.
  if (!Number.isSafeInteger(state.observationStartedAtMicros)) state.observationStartedAtMicros = Date.now() * 1000 + 999;
  if (!await openChat() || !owns()) return JSON.stringify({ status: "rejected", message: "Meet chat is unavailable for the current session." });
  if (composers().length !== 1) return JSON.stringify({ status: "rejected", message: "Meet chat has not finished opening." });
  const initial = !state.messages;
  if (initial) {
    state.epoch = crypto.randomUUID();
    state.messages = new Map();
    state.historicalIds = new Set();
  }
  const sources = [];
  const visibleIds = new Set();
  let unrecognizedRows = 0;
  // Nested Pin-message controls repeat data-message-id. Only the outer native
  // message row establishes one identity, including repeated identical text.
  for (const row of [...document.querySelectorAll(".RLrADb[data-message-id]")].slice(-128)) {
    const id = row.getAttribute("data-message-id");
    if (!id || id.length > 512 || !/^spaces[/][^/]+[/]messages[/][^/]+$/.test(id)) continue;
    visibleIds.add(id);
    const previous = state.messages.get(id);
    const group = row.closest(".aops0b");
    const header = group?.querySelector(".HNucUd");
    const speakerNode = header?.querySelector(".poVWob");
    const speaker = text(speakerNode);
    const ownClass = Boolean(row.querySelector(".jO4O1.chmVPb"));
    const peerClass = Boolean(row.querySelector(".jO4O1:not(.chmVPb)"));
    // Names are only labels. The native own-row marker and header shape must
    // agree; an unknown layout never becomes participant authority.
    const ownEcho = header && ownClass && !peerClass && !speakerNode ? true
      : header && peerClass && !ownClass && speakerNode && speaker ? false : undefined;
    const value = text(row.querySelector('div[jsname="dTKtvb"]'));
    if (ownEcho === undefined) unrecognizedRows += 1;
    const finalized = ownEcho !== undefined && Boolean(value);
    const content = finalized ? value : "";
    const nativeTimestamp = id.match(/[/]messages[/]([0-9]{16})$/)?.[1];
    const createdAtMicros = nativeTimestamp ? Number(nativeTimestamp) : NaN;
    const fresh = !initial && Number.isSafeInteger(createdAtMicros) &&
      createdAtMicros > state.observationStartedAtMicros && createdAtMicros <= Date.now() * 1000 + 999;
    const historical = previous?.historical ??
      (state.historicalIds.has(id) || state.historicalCapacityExhausted === true || !fresh);
    // Old/malformed IDs always fail the fixed cutoff. Preserve exceptional
    // initial/future IDs separately so row-cache eviction cannot promote them.
    if (historical && Number.isSafeInteger(createdAtMicros) && createdAtMicros > state.observationStartedAtMicros && !state.historicalIds.has(id)) {
      if (state.historicalIds.size >= 1024) state.historicalCapacityExhausted = true;
      else state.historicalIds.add(id);
    }
    if (!finalized && !previous) continue;
    const revision = previous && previous.text === content && previous.ownEcho === ownEcho
      ? previous.revision : String(Number(previous?.revision || 0) + 1);
    const source = { id, epoch: state.epoch, revision, kind: "chat", text: content,
      ownEcho, finalized, speaker: speaker || undefined,
      historical, at: previous?.at || new Date().toISOString() };
    state.messages.set(id, source);
    sources.push(source);
  }
  for (const [id, previous] of state.messages) {
    if (visibleIds.has(id) || !previous.finalized) continue;
    const source = { ...previous, text: "", finalized: false, revision: String(Number(previous.revision) + 1) };
    state.messages.set(id, source);
    sources.push(source);
  }
  while (state.messages.size > 256) state.messages.delete(state.messages.keys().next().value);
  if (!owns()) return JSON.stringify({ status: "rejected", message: "This session no longer owns an active Meet tab." });
  return JSON.stringify({ status: "succeeded", epoch: state.epoch, sources, unrecognizedRows });
}`;
}

export function meetSendChatScript(
  params: MeetChatPageRequest & {
    requestId: string;
    text: string;
    source?: MeetingParticipationSource;
  },
): string {
  return `async () => {${meetChatPrelude(params)}
  ${meetParticipationSourceCheck(params)}
  if (!sourceCurrent()) return JSON.stringify({ status: "rejected", message: "The original meeting request changed before sending." });
  const requestId = ${JSON.stringify(params.requestId)};
  const message = ${JSON.stringify(params.text)};
  const previous = state.attempts.get(requestId);
  if (previous) return JSON.stringify(previous.text === message ? previous.result :
    { status: "rejected", message: "This chat request ID was already used with different text." });
  if (state.attempts.size >= 256) return JSON.stringify({ status: "rejected", message: "This page's chat request capacity is exhausted. Rejoin before sending more messages." });
  const matches = composers();
  if (matches.length !== 1 || !enabled(matches[0])) return JSON.stringify({ status: "failed", message: "Meet chat needs one enabled message composer." });
  const composer = matches[0];
  const value = () => "value" in composer ? composer.value : composer.textContent || "";
  const sameComposer = () => owns() && composer.ownerDocument === document &&
    composer.isConnected && composers().length === 1 && composers()[0] === composer && enabled(composer);
  if (!sameComposer() || value() !== "") return JSON.stringify({ status: "rejected", message: "Meet chat already contains a draft; it was left unchanged." });
  const setter = composer.tagName === "TEXTAREA" ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set : undefined;
  if (!setter && !composer.isContentEditable) return JSON.stringify({ status: "failed", message: "The native Meet composer is not editable." });
  composer.focus();
  if (!sameComposer() || document.activeElement !== composer || value() !== "") return JSON.stringify({ status: "rejected", message: "Meet chat changed before writing; no message was sent." });
  if (setter) setter.call(composer, message);
  else composer.textContent = message;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: message }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  if (!sameComposer() || document.activeElement !== composer || value() !== message) return JSON.stringify({ status: "rejected", message: "Meet chat changed before sending; no send was attempted." });
  const sendButtons = [...document.querySelectorAll('button[aria-label="Send a message"][jsname="SoqoBf"]')].filter(visible);
  if (sendButtons.length !== 1 || !enabled(sendButtons[0])) return JSON.stringify({ status: "failed", message: "Meet's native Send button is not ready. The message remains in the composer." });
  const send = sendButtons[0];
  if (!sameComposer() || !sourceCurrent() || value() !== message || !send.isConnected || send.ownerDocument !== document) return JSON.stringify({ status: "rejected", message: "Meet chat changed before sending; no send was attempted." });
  const attempt = { text: message, result: { status: "uncertain", message: "Meet chat send was attempted without a confirmed effect. Do not retry automatically." } };
  // Remember uncertainty before the write. A transport timeout or a concurrent
  // repeat must never cause another Send click for this request.
  state.attempts.set(requestId, attempt);
  send.click();
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!owns()) return JSON.stringify(attempt.result);
    if (sameComposer() && value() === "") {
      attempt.result = { status: "succeeded", observed: { confirmation: "composer_cleared" } };
      return JSON.stringify(attempt.result);
    }
  }
  return JSON.stringify(attempt.result);
}`;
}
