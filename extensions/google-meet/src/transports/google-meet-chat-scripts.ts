import type {
  MeetingBrowserParticipationAdapter,
  MeetingParticipationAction,
  MeetingParticipationEffectResult,
  MeetingParticipationSource,
} from "openclaw/plugin-sdk/meeting-runtime";
import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";

export const GOOGLE_MEET_CHAT_ACTION = "chat";
export const GOOGLE_MEET_CHAT_MAX_TEXT_LENGTH = 4_000;
const CHAT_PANEL_OPEN_TIMEOUT_MS = 4_000;
const CHAT_SEND_OBSERVE_TIMEOUT_MS = 2_500;
const CHAT_READ_MAX_MESSAGES = 200;

// Meet renders in-call messages inside the "Side panel" aside. Every selector
// below was observed on the English (hl=en) UI; Ctrl+Alt+C is Meet's documented
// keyboard shortcut for toggling the chat panel and works from a synthetic
// keydown, so no trusted input is required.
const CHAT_DOM_SOURCE = `
  const chatTextarea = () => document.querySelector('textarea[jsname="YPqjbf"], textarea[aria-label="Send a message"]');
  const chatSendButton = () => document.querySelector('button[jsname="SoqoBf"], button[aria-label="Send a message"]');
  const chatLog = () => document.querySelector('[jsname="xySENc"]');
  const chatText = (node) => (node?.innerText || node?.textContent || "").trim();
  const toggleChatPanel = () => {
    const init = { key: "c", code: "KeyC", keyCode: 67, which: 67, ctrlKey: true, altKey: true, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent("keydown", init));
    document.body.dispatchEvent(new KeyboardEvent("keyup", init));
  };
  const readChatMessages = () => {
    const log = chatLog();
    if (!log) return undefined;
    const messages = [];
    for (const group of log.querySelectorAll('[jsname="Ypafjf"]')) {
      const header = group.querySelector('[jsname="biJjHb"]')?.parentElement;
      const sender = header
        ? [...header.children].filter((child) => child.getAttribute("jsname") !== "biJjHb").map(chatText).find(Boolean)
        : undefined;
      const at = chatText(group.querySelector('[jsname="biJjHb"]')) || undefined;
      for (const row of group.querySelectorAll("[data-message-id]")) {
        const id = row.getAttribute("data-message-id") || "";
        const text = chatText(row.querySelector('[jsname="dTKtvb"]') || row);
        if (!id || !text) continue;
        messages.push({ id, text, sender, at, self: !sender });
      }
    }
    return messages.slice(-${CHAT_READ_MAX_MESSAGES});
  };
`;

function meetingUrlGuard(meetingUrl: string, failure: string): string {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify(${failure});
  }
  if (!expectedMeetingUrl || currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify(${failure});
  }`;
}

export function meetChatReadScript(meetingUrl: string): string {
  return `() => {${meetingUrlGuard(meetingUrl, "{ urlMatched: false }")}
  ${CHAT_DOM_SOURCE}
  const messages = readChatMessages();
  return JSON.stringify({ urlMatched: true, panelOpen: messages !== undefined, messages: messages ?? [] });
}`;
}

export function meetChatPreparationScript(meetingUrl: string): string {
  return `async () => {${meetingUrlGuard(meetingUrl, "{ urlMatched: false }")}
  ${CHAT_DOM_SOURCE}
  if (!chatTextarea()) toggleChatPanel();
  const deadline = Date.now() + ${CHAT_PANEL_OPEN_TIMEOUT_MS};
  while (!chatTextarea() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return JSON.stringify({ urlMatched: true, ready: Boolean(chatTextarea() && chatSendButton()) });
}`;
}

export function meetChatSendScript(meetingUrl: string, text: string): string {
  return `async () => {${meetingUrlGuard(meetingUrl, "{ urlMatched: false, sent: false }")}
  ${CHAT_DOM_SOURCE}
  const textarea = chatTextarea();
  const send = chatSendButton();
  if (!textarea || !send) return JSON.stringify({ urlMatched: true, sent: false, reason: "chat-panel-closed" });
  const before = new Set((readChatMessages() || []).map((message) => message.id));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(textarea, ${JSON.stringify(text)}); else textarea.value = ${JSON.stringify(text)};
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
  if (send.disabled || send.getAttribute("aria-disabled") === "true") {
    return JSON.stringify({ urlMatched: true, sent: false, reason: "send-disabled" });
  }
  send.click();
  const deadline = Date.now() + ${CHAT_SEND_OBSERVE_TIMEOUT_MS};
  let observed;
  while (!observed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    observed = (readChatMessages() || []).find((message) => !before.has(message.id) && message.self && message.text === ${JSON.stringify(text)});
  }
  return JSON.stringify({ urlMatched: true, sent: true, ...(observed ? { messageId: observed.id } : {}) });
}`;
}

function parseScriptResult(result: unknown): Record<string, unknown> | undefined {
  const raw = typeof result === "string" ? result : (result as { result?: unknown })?.result;
  if (typeof raw !== "string") {
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export type GoogleMeetChatMessage = {
  id: string;
  text: string;
  sender?: string;
  at?: string;
  self: boolean;
};

export function parseMeetChatReadResult(result: unknown): GoogleMeetChatMessage[] | undefined {
  const parsed = parseScriptResult(result);
  if (!parsed || parsed.urlMatched !== true || !Array.isArray(parsed.messages)) {
    return undefined;
  }
  return parsed.messages.flatMap((entry: unknown) => {
    const row = entry as Partial<GoogleMeetChatMessage> | undefined;
    if (!row || typeof row.id !== "string" || typeof row.text !== "string") {
      return [];
    }
    return [
      {
        id: row.id,
        text: row.text,
        ...(typeof row.sender === "string" && row.sender ? { sender: row.sender } : {}),
        ...(typeof row.at === "string" && row.at ? { at: row.at } : {}),
        self: row.self === true,
      },
    ];
  });
}

/** Chat rows are immutable once posted, so each message is a single finalized revision. */
export function meetChatParticipationSources(
  messages: readonly GoogleMeetChatMessage[],
  params: { meetingSessionId: string; epoch: string },
): MeetingParticipationSource[] {
  return messages.map((message) => ({
    kind: "chat",
    id: `${params.meetingSessionId}:chat:${message.id}`,
    epoch: params.epoch,
    revision: "1",
    finalized: true,
    ownEcho: message.self,
    text: message.text,
    provenance: {
      observer: "google-meet-chat-dom",
      observationId: `${params.meetingSessionId}:chat:${message.id}`,
      sessionId: params.meetingSessionId,
      epoch: params.epoch,
      ...(message.sender ? { speaker: message.sender } : {}),
      self: message.self ? "self" : "other",
    },
  }));
}

export function validateMeetChatAction(action: MeetingParticipationAction): string | undefined {
  if (action.type !== GOOGLE_MEET_CHAT_ACTION) {
    return `Unsupported participation action "${action.type}".`;
  }
  const text = typeof action.text === "string" ? action.text.trim() : "";
  if (!text) {
    return "A chat action requires non-empty text.";
  }
  if (text.length > GOOGLE_MEET_CHAT_MAX_TEXT_LENGTH) {
    return `Chat messages are limited to ${GOOGLE_MEET_CHAT_MAX_TEXT_LENGTH} characters.`;
  }
  return undefined;
}

function chatActionText(action: MeetingParticipationAction): string {
  return typeof action.text === "string" ? action.text.trim() : "";
}

export const GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER: MeetingBrowserParticipationAdapter = {
  capabilities: [GOOGLE_MEET_CHAT_ACTION],
  validateAction: validateMeetChatAction,
  buildPreparationScript: ({ meetingUrl }) => meetChatPreparationScript(meetingUrl),
  parsePreparationResult: (result): MeetingParticipationEffectResult => {
    const parsed = parseScriptResult(result);
    if (parsed?.urlMatched !== true) {
      return {
        status: "rejected",
        message: "The tracked browser tab no longer shows this meeting; no message was sent.",
        correctable: true,
      };
    }
    if (parsed.ready !== true) {
      return { status: "failed", message: "The Google Meet chat panel could not be opened." };
    }
    return { status: "succeeded" };
  },
  buildActionScript: ({ meetingUrl, action }) =>
    meetChatSendScript(meetingUrl, chatActionText(action)),
  parseActionResult: (result): MeetingParticipationEffectResult => {
    const parsed = parseScriptResult(result);
    if (!parsed) {
      return { status: "uncertain", message: "The chat send result could not be read." };
    }
    if (parsed.urlMatched !== true) {
      return {
        status: "rejected",
        message: "The tracked browser tab no longer shows this meeting; no message was sent.",
        correctable: true,
      };
    }
    if (parsed.sent !== true) {
      return {
        status: "rejected",
        message:
          parsed.reason === "send-disabled"
            ? "Google Meet did not accept the chat message (send disabled); no message was sent."
            : "The Google Meet chat panel is not open; no message was sent.",
        correctable: true,
      };
    }
    return typeof parsed.messageId === "string"
      ? { status: "succeeded", observed: { messageId: parsed.messageId } }
      : {
          status: "uncertain",
          message: "The chat message was submitted but was not observed in the message log.",
        };
  },
};
