import { createContext, runInContext } from "node:vm";
import { vi } from "vitest";
import type { GoogleMeetChatSource } from "../google-meet-chat.js";
import {
  meetPrepareChatScript,
  meetReadChatScript,
  meetSendChatScript,
} from "../transports/google-meet-chat-scripts.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";
const MESSAGE = "Here is the meeting follow-up.";

type ChatResult = {
  status: "succeeded" | "rejected" | "failed" | "uncertain";
  observed?: { confirmation: string; messageId?: string };
};
type ChatReadResult =
  | {
      status: "succeeded";
      epoch: string;
      sources: GoogleMeetChatSource[];
      unrecognizedRows: number;
    }
  | { status: "rejected"; message: string };

type FixtureMessage = {
  id: string;
  text: string;
  groupId?: string;
  speaker?: string;
  ownEcho?: boolean;
};

class ChatDocument {
  activeElement: PageNode | null = null;
  composers: GoogleMeetChatComposer[] = [];
  buttons: PageNode[] = [];
  messageGroups: PageNode[] = [];

  querySelectorAll(selector: string) {
    if (selector === "button" || selector === "button[aria-label]") {
      return this.buttons;
    }
    if (selector === 'button[aria-label="Send a message"][jsname="SoqoBf"]') {
      return this.buttons.filter(
        (button) =>
          button.getAttribute("aria-label") === "Send a message" &&
          button.getAttribute("jsname") === "SoqoBf",
      );
    }
    if (selector.includes("textarea")) {
      return this.composers;
    }
    return this.messageGroups.flatMap((group) => [
      ...(group.matches(selector) ? [group] : []),
      ...group.querySelectorAll(selector),
    ]);
  }
}

class PageNode {
  disabled = false;
  readOnly = false;
  isConnected = true;
  isContentEditable = false;
  tagName = "DIV";
  children: PageNode[] = [];
  parentElement: PageNode | null = null;
  private content = "";
  attributes: Record<string, string>;
  click = vi.fn<() => void>();
  focus = vi.fn(() => {
    this.ownerDocument.activeElement = this;
  });
  dispatchEvent = vi.fn((_event: Event) => true);

  constructor(
    public ownerDocument: ChatDocument,
    label: string,
  ) {
    this.attributes = { "aria-label": label };
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.content = value;
    this.children = [];
  }

  append(...children: PageNode[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  matches(selector: string): boolean {
    let matched = true;
    let remaining = selector.replace(/:not\(([^)]+)\)/g, (_match, excluded: string) => {
      matched &&= !this.matches(excluded);
      return "";
    });
    remaining = remaining.replace(/^[a-z][\w-]*/i, (tag) => {
      matched &&= this.tagName === tag.toUpperCase();
      return "";
    });
    remaining = remaining.replace(
      /\[([\w-]+)(?:=["']([^"']*)["'])?\]/g,
      (_match, name: string, value?: string) => {
        const attribute = this.getAttribute(name);
        matched &&= value === undefined ? attribute !== null : attribute === value;
        return "";
      },
    );
    remaining = remaining.replace(/\.([\w-]+)/g, (_match, className: string) => {
      matched &&= (this.getAttribute("class") ?? "").split(/\s+/).includes(className);
      return "";
    });
    if (remaining) {
      throw new Error(`Unsupported fixture selector: ${selector}`);
    }
    return matched;
  }

  querySelectorAll(selector: string): PageNode[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string): PageNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): PageNode | null {
    return closestPageNode(this, selector);
  }

  getBoundingClientRect() {
    return { width: 100, height: 30 };
  }
}

export class GoogleMeetChatComposer extends PageNode {
  private contents = "";

  constructor(document: ChatDocument) {
    super(document, "Send a message");
    this.tagName = "TEXTAREA";
  }

  get value() {
    return this.contents;
  }

  set value(next: string) {
    this.contents = next;
  }
}

class ChatInputEvent extends Event {
  readonly inputType: string;
  readonly data: string;

  constructor(
    type: string,
    options: { inputType: string; data: string; bubbles?: boolean; composed?: boolean },
  ) {
    super(type, options);
    this.inputType = options.inputType;
    this.data = options.data;
  }
}

function parseScriptResult(result: unknown): unknown {
  if (typeof result !== "string") {
    throw new Error("Expected a JSON string from the Meet chat script.");
  }
  return JSON.parse(result);
}

export function nativeGoogleMeetChatMessageId(
  createdAtMs = Date.now(),
  microsecondOffset = 0,
): string {
  return `spaces/test/messages/${createdAtMs * 1_000 + microsecondOffset}`;
}

export function createGoogleMeetChatPage({
  sessionId = "session-1",
  meetingUrl = MEETING_URL,
}: {
  sessionId?: string;
  meetingUrl?: string;
} = {}) {
  const document = new ChatDocument();
  const composer = new GoogleMeetChatComposer(document);
  const toggle = new PageNode(document, "Chat with everyone");
  const sendButton = new PageNode(document, "Send a message");
  sendButton.attributes.role = "button";
  sendButton.attributes.jsname = "SoqoBf";
  sendButton.disabled = true;
  composer.dispatchEvent.mockImplementation((event) => {
    if (event.type === "input") {
      sendButton.disabled = composer.value === "";
    }
    return true;
  });
  document.composers = [composer];
  document.buttons = [new PageNode(document, "Leave call"), toggle, sendButton];
  const window: {
    __openclawMeetAudioSession: string;
    __openclawMeetChat?: unknown;
  } = { __openclawMeetAudioSession: sessionId };
  const location = { href: meetingUrl };
  const onWait = vi.fn<() => void>();
  const beforeSend = vi.fn<() => void | Promise<void>>();
  const groups = new Map<string, { group: PageNode; header: PageNode }>();
  const messages = new Map<string, { row: PageNode; content: PageNode }>();
  const addMessage = ({
    id,
    text,
    groupId = id,
    speaker = "Participant",
    ownEcho = false,
  }: FixtureMessage) => {
    if (messages.has(id)) {
      throw new Error(`Fixture message already exists: ${id}`);
    }
    let groupNodes = groups.get(groupId);
    if (!groupNodes) {
      const group = new PageNode(document, "");
      group.attributes.class = "aops0b";
      const header = new PageNode(document, "");
      header.attributes.class = "HNucUd";
      if (!ownEcho) {
        const sender = new PageNode(document, "");
        sender.attributes.class = "poVWob";
        sender.textContent = speaker;
        header.append(sender);
      }
      const timestamp = new PageNode(document, "");
      timestamp.textContent = "10:00 AM";
      header.append(timestamp);
      group.append(header);
      groupNodes = { group, header };
      groups.set(groupId, groupNodes);
      document.messageGroups.push(group);
    }
    const row = new PageNode(document, "");
    row.attributes.class = "RLrADb";
    row.attributes["data-message-id"] = id;
    const body = new PageNode(document, "");
    body.attributes.class = `jO4O1${ownEcho ? " chmVPb" : ""}`;
    const bodyContainer = new PageNode(document, "");
    bodyContainer.attributes.class = "ptNLrf";
    const textContainer = new PageNode(document, "");
    textContainer.attributes.jsname = "dTKtvb";
    const content = new PageNode(document, "");
    content.textContent = text;
    textContainer.append(content);
    bodyContainer.append(textContainer);
    body.append(bodyContainer);
    const pin = new PageNode(document, "Pin message");
    pin.tagName = "BUTTON";
    pin.attributes.role = "button";
    pin.attributes["data-message-id"] = id;
    row.append(body, pin);
    groupNodes.group.append(row);
    messages.set(id, { row, content });
    return { ...groupNodes, row, body, textContainer, content, pin };
  };
  const editMessage = (id: string, text: string) => {
    const message = messages.get(id);
    if (!message) {
      throw new Error(`Fixture message does not exist: ${id}`);
    }
    message.content.textContent = text;
  };
  const removeMessage = (id: string) => {
    const message = messages.get(id);
    if (!message) {
      throw new Error(`Fixture message does not exist: ${id}`);
    }
    message.row.remove();
    messages.delete(id);
  };
  let epoch = 0;
  const context = createContext({
    // Share Vitest's controlled Date with direct browser evaluations as well as read().
    Date,
    URL,
    Event,
    InputEvent: ChatInputEvent,
    HTMLTextAreaElement: GoogleMeetChatComposer,
    crypto: { randomUUID: () => `chat-epoch-${++epoch}` },
    document,
    window,
    location,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout: (callback: () => void) => {
      onWait();
      callback();
      return 1;
    },
  });
  const evaluate = async (script: string): Promise<unknown> =>
    runInContext(`(${script})()`, context);
  const prepare = async () =>
    parseScriptResult(
      await evaluate(meetPrepareChatScript({ meetingSessionId: sessionId, meetingUrl })),
    ) as ChatResult | { status: "prepared" };
  const read = async () =>
    parseScriptResult(
      await evaluate(meetReadChatScript({ meetingSessionId: sessionId, meetingUrl })),
    ) as ChatReadResult;
  const send = async (
    requestId = "request-1",
    text = MESSAGE,
    source?: Parameters<typeof meetSendChatScript>[0]["source"],
  ): Promise<ChatResult> => {
    const prepared = await prepare();
    if (prepared.status !== "prepared") {
      return prepared;
    }
    await beforeSend();
    return parseScriptResult(
      await evaluate(
        meetSendChatScript({ meetingSessionId: sessionId, meetingUrl, requestId, text, source }),
      ),
    ) as ChatResult;
  };
  const sendEvents = () => sendButton.click.mock.calls;
  const acceptSend = () => {
    sendButton.click.mockImplementation(() => {
      composer.value = "";
      sendButton.disabled = true;
    });
  };
  return {
    document,
    composer,
    toggle,
    sendButton,
    window,
    location,
    onWait,
    beforeSend,
    evaluate,
    prepare,
    read,
    addMessage,
    editMessage,
    removeMessage,
    send,
    sendEvents,
    acceptSend,
  };
}

function closestPageNode(startNode: PageNode | null, selector: string): PageNode | null {
  for (let node = startNode; node; node = node.parentElement) {
    if (node.matches(selector)) {
      return node;
    }
  }
  return null;
}
