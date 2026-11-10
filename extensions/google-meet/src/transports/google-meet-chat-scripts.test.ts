import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { MEET_URL, MEET_URL_EN } from "../test-support/fixtures.test-helpers.js";
import {
  GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER,
  meetChatParticipationSources,
  meetChatPreparationScript,
  meetChatReadScript,
  meetChatSendScript,
  parseMeetChatReadResult,
  validateMeetChatAction,
} from "./google-meet-chat-scripts.js";

const sessionId = "chat-session";

function messageGroup(params: { id: string; text: string; sender?: string; at: string }) {
  const sender = params.sender ? `<div class="poVWob">${params.sender}</div>` : "";
  return `<div jsname="Ypafjf" class="Ss4fHf${params.sender ? "" : " ydIQ1d"}">
    <div class="HNucUd">${sender}<div jsname="biJjHb">${params.at}</div></div>
    <div class="RLrADb" data-message-id="${params.id}">
      <div jsname="dTKtvb">${params.text}</div><span>Pin</span>
    </div>
  </div>`;
}

function chatPanel(groups: string[], options: { sendDisabled?: boolean } = {}) {
  return `<aside aria-label="Side panel">
    <div jsname="xySENc" aria-live="polite">${groups.join("")}</div>
    <textarea jsname="YPqjbf" aria-label="Send a message" maxlength="4000"></textarea>
    <button jsname="SoqoBf" aria-label="Send a message" ${options.sendDisabled ? "disabled" : ""}></button>
  </aside>`;
}

function page(body: string, url = MEET_URL_EN) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url, runScripts: "outside-only" });
  const run = async (script: string): Promise<unknown> => await dom.window.eval(`(${script})()`);
  return { dom, run };
}

const luke = { id: "spaces/s/messages/1", text: "ok cool", sender: "Luke", at: "12:31 PM" };
const own = { id: "spaces/s/messages/2", text: "Hi from Bak", at: "12:32 PM" };

describe("meetChatReadScript", () => {
  it("reads messages with sender attribution and self detection", async () => {
    const { run } = page(chatPanel([messageGroup(luke), messageGroup(own)]));
    const messages = parseMeetChatReadResult(await run(meetChatReadScript(MEET_URL)));
    expect(messages).toStrictEqual([
      { id: luke.id, text: luke.text, sender: "Luke", at: luke.at, self: false },
      { id: own.id, text: own.text, at: own.at, self: true },
    ]);
  });

  it("returns an empty list when the chat panel is closed", async () => {
    const { run } = page("<div>in call</div>");
    expect(parseMeetChatReadResult(await run(meetChatReadScript(MEET_URL)))).toStrictEqual([]);
  });

  it("returns undefined when the tab shows another meeting", async () => {
    const { run } = page(chatPanel([messageGroup(luke)]), "https://meet.google.com/zzz-zzzz-zzz");
    expect(parseMeetChatReadResult(await run(meetChatReadScript(MEET_URL)))).toBeUndefined();
  });
});

describe("meetChatPreparationScript", () => {
  it("opens the panel with the Ctrl+Alt+C shortcut when the composer is missing", async () => {
    const { dom, run } = page("<div>in call</div>");
    dom.window.document.body.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (key.key === "c" && key.ctrlKey && key.altKey) {
        dom.window.document.body.insertAdjacentHTML("beforeend", chatPanel([]));
      }
    });
    const prepared = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parsePreparationResult?.(
      await run(meetChatPreparationScript(MEET_URL)),
      { type: "chat", text: "hi" },
    );
    expect(prepared).toStrictEqual({ status: "succeeded" });
  });

  it("rejects preparation on a different meeting", async () => {
    const { run } = page(chatPanel([]), "https://meet.google.com/zzz-zzzz-zzz");
    const prepared = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parsePreparationResult?.(
      await run(meetChatPreparationScript(MEET_URL)),
      { type: "chat", text: "hi" },
    );
    expect(prepared?.status).toBe("rejected");
  });
});

describe("meetChatSendScript", () => {
  it("fills the composer, clicks send, and observes the posted message", async () => {
    const { dom, run } = page(chatPanel([messageGroup(luke)]));
    const document = dom.window.document;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[jsname="YPqjbf"]');
    const inputs: string[] = [];
    textarea?.addEventListener("input", () => inputs.push(textarea.value));
    document.querySelector('button[jsname="SoqoBf"]')?.addEventListener("click", () => {
      document
        .querySelector('[jsname="xySENc"]')
        ?.insertAdjacentHTML(
          "beforeend",
          messageGroup({ id: "spaces/s/messages/9", text: textarea?.value ?? "", at: "12:40 PM" }),
        );
    });
    const result = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parseActionResult(
      await run(meetChatSendScript(MEET_URL, "Hello from Bak")),
      { type: "chat", text: "Hello from Bak" },
    );
    expect(inputs).toStrictEqual(["Hello from Bak"]);
    expect(result).toStrictEqual({
      status: "succeeded",
      observed: { messageId: "spaces/s/messages/9" },
    });
  });

  it("is uncertain when the message was submitted but never appeared", async () => {
    const { run } = page(chatPanel([]));
    const result = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parseActionResult(
      await run(meetChatSendScript(MEET_URL, "Lost message")),
      { type: "chat", text: "Lost message" },
    );
    expect(result.status).toBe("uncertain");
  }, 10_000);

  it("rejects without sending when the composer is closed or send is disabled", async () => {
    const closed = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parseActionResult(
      await page("<div>in call</div>").run(meetChatSendScript(MEET_URL, "x")),
      { type: "chat", text: "x" },
    );
    expect(closed).toMatchObject({ status: "rejected", correctable: true });
    const disabled = GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.parseActionResult(
      await page(chatPanel([], { sendDisabled: true })).run(meetChatSendScript(MEET_URL, "x")),
      { type: "chat", text: "x" },
    );
    expect(disabled).toMatchObject({ status: "rejected", correctable: true });
    expect(disabled.message).toContain("send disabled");
  });
});

describe("chat participation adapter", () => {
  it("validates chat actions", () => {
    expect(validateMeetChatAction({ type: "chat", text: "hello" })).toBeUndefined();
    expect(validateMeetChatAction({ type: "chat", text: "   " })).toMatch(/non-empty/);
    expect(validateMeetChatAction({ type: "chat", text: "x".repeat(4_001) })).toMatch(/4000/);
    expect(validateMeetChatAction({ type: "reaction", reaction: "👍" })).toMatch(/Unsupported/);
    expect(GOOGLE_MEET_CHAT_PARTICIPATION_ADAPTER.capabilities).toStrictEqual(["chat"]);
  });

  it("maps messages to finalized chat sources and flags own messages as echo", () => {
    const sources = meetChatParticipationSources(
      [
        { id: luke.id, text: luke.text, sender: "Luke", at: luke.at, self: false },
        { id: own.id, text: own.text, self: true },
      ],
      { meetingSessionId: sessionId, epoch: "epoch-1" },
    );
    expect(sources).toStrictEqual([
      {
        kind: "chat",
        id: `${sessionId}:chat:${luke.id}`,
        epoch: "epoch-1",
        revision: "1",
        finalized: true,
        ownEcho: false,
        text: "ok cool",
        provenance: {
          observer: "google-meet-chat-dom",
          observationId: `${sessionId}:chat:${luke.id}`,
          sessionId,
          epoch: "epoch-1",
          speaker: "Luke",
          self: "other",
        },
      },
      {
        kind: "chat",
        id: `${sessionId}:chat:${own.id}`,
        epoch: "epoch-1",
        revision: "1",
        finalized: true,
        ownEcho: true,
        text: "Hi from Bak",
        provenance: {
          observer: "google-meet-chat-dom",
          observationId: `${sessionId}:chat:${own.id}`,
          sessionId,
          epoch: "epoch-1",
          self: "self",
        },
      },
    ]);
  });
});
