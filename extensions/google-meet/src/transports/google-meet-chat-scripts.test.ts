import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleMeetChatPage as chatPage,
  GoogleMeetChatComposer as Composer,
  nativeGoogleMeetChatMessageId as nativeMessageId,
} from "../test-support/google-meet-chat.test-helpers.js";

const MESSAGE = "Here is the meeting follow-up.";
const STARTED_AT_MS = Date.parse("2026-09-15T10:00:00Z");
const FIRST_NATIVE_ID = nativeMessageId(STARTED_AT_MS - 2);
const SECOND_NATIVE_ID = nativeMessageId(STARTED_AT_MS - 1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(STARTED_AT_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

async function readChat(page: ReturnType<typeof chatPage>) {
  const result = await page.read();
  expect(result.status).toBe("succeeded");
  if (result.status !== "succeeded") {
    throw new Error(result.message);
  }
  return result;
}

describe("meetSendChatScript", () => {
  it("confirms editor acceptance when the same composer clears without an incoming echo", async () => {
    const page = chatPage();
    expect(page.sendButton.disabled).toBe(true);
    page.acceptSend();

    expect(await page.send()).toEqual({
      status: "succeeded",
      observed: { confirmation: "composer_cleared" },
    });
    expect(page.sendButton.click).toHaveBeenCalledOnce();
    expect(page.composer.value).toBe("");
    expect(page.sendButton.disabled).toBe(true);
  });

  it.each(["missing", "disabled"])(
    "retains the composed message without sending when the native Send button is %s",
    async (state) => {
      const page = chatPage();
      if (state === "missing") {
        page.document.buttons = page.document.buttons.filter(
          (button) => button !== page.sendButton,
        );
      } else {
        page.composer.dispatchEvent.mockImplementation(() => true);
      }

      expect((await page.send()).status).toBe("failed");
      expect(page.composer.value).toBe(MESSAGE);
      expect(page.sendButton.click).not.toHaveBeenCalled();
    },
  );

  it("does not resend an uncertain request when it is repeated", async () => {
    const page = chatPage();

    const first = await page.send();
    const repeated = await page.send();

    expect(first.status).toBe("uncertain");
    expect(repeated).toEqual(first);
    expect(page.sendButton.click).toHaveBeenCalledOnce();
    expect(page.composer.value).toBe(MESSAGE);
  });

  it("sends concurrent calls with the same request ID only once", async () => {
    const page = chatPage();
    page.acceptSend();

    const results = await Promise.all([page.send(), page.send()]);

    expect(page.sendButton.click).toHaveBeenCalledOnce();
    expect(results.some((result) => result.status === "succeeded")).toBe(true);
  });

  it("rejects changed text for an already attempted request", async () => {
    const page = chatPage();
    page.acceptSend();
    await page.send();

    expect((await page.send("request-1", "Different text")).status).toBe("rejected");
    expect(page.sendButton.click).toHaveBeenCalledOnce();
    expect(page.composer.value).toBe("");
  });

  it.each(["My unfinished draft", " \n "])(
    "preserves the existing draft %j without focusing or sending",
    async (draft) => {
      const page = chatPage();
      page.composer.value = draft;

      expect((await page.send()).status).toBe("rejected");
      expect(page.composer.value).toBe(draft);
      expect(page.composer.focus).not.toHaveBeenCalled();
      expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses a matching textbox that is not editable", async () => {
    const page = chatPage();
    page.composer.tagName = "DIV";

    expect((await page.send()).status).toBe("failed");
    expect(page.composer.value).toBe("");
    expect(page.composer.focus).not.toHaveBeenCalled();
    expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
  });

  it("refuses to choose between multiple composers", async () => {
    const page = chatPage();
    const second = new Composer(page.document);
    page.document.composers.push(second);

    expect((await page.send()).status).toBe("failed");
    expect(page.composer.value).toBe("");
    expect(second.value).toBe("");
    expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
    expect(second.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each(["disabled", "readOnly", "aria-disabled", "aria-readonly"])(
    "does not write into a composer with %s set",
    async (state) => {
      const page = chatPage();
      if (state.startsWith("aria-")) {
        page.composer.attributes[state] = "true";
      } else if (state === "disabled") {
        page.composer.disabled = true;
      } else {
        page.composer.readOnly = true;
      }

      expect((await page.send()).status).toBe("failed");
      expect(page.composer.value).toBe("");
      expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "url", "left-call"])(
    "refuses a tab whose %s no longer matches the active meeting",
    async (mismatch) => {
      const page = chatPage();
      if (mismatch === "session") {
        page.window["__openclawMeetAudioSession"] = "other-session";
      } else if (mismatch === "url") {
        page.location.href = "https://meet.google.com/klm-nopq-rst";
      } else {
        page.document.buttons = [page.toggle];
      }

      expect((await page.send()).status).toBe("rejected");
      expect(page.composer.focus).not.toHaveBeenCalled();
      expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
      expect(page.toggle.click).not.toHaveBeenCalled();
    },
  );

  it("does not write if focusing the composer revokes ownership", async () => {
    const page = chatPage();
    page.composer.focus.mockImplementation(() => {
      page.document.activeElement = page.composer;
      page.window["__openclawMeetAudioSession"] = "other-session";
    });

    expect((await page.send()).status).toBe("rejected");
    expect(page.composer.value).toBe("");
    expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
  });

  it("rechecks page ownership between preparation and the final send evaluation", async () => {
    const page = chatPage();
    page.beforeSend.mockImplementation(() => {
      page.window["__openclawMeetAudioSession"] = "other-session";
    });

    expect((await page.send()).status).toBe("rejected");
    expect(page.composer.value).toBe("");
    expect(page.composer.dispatchEvent).not.toHaveBeenCalled();
  });

  it("does not send if an input handler revokes ownership", async () => {
    const page = chatPage();
    page.composer.dispatchEvent.mockImplementation((event) => {
      if (event.type === "input") {
        page.window["__openclawMeetAudioSession"] = "other-session";
      }
      return true;
    });

    expect((await page.send()).status).toBe("rejected");
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it.each(["session", "chat-state"])(
    "does not confirm a cleared composer after %s ownership is lost while awaiting the effect",
    async (ownership) => {
      const page = chatPage();
      page.onWait.mockImplementationOnce(() => {
        page.composer.value = "";
        if (ownership === "session") {
          page.window["__openclawMeetAudioSession"] = "other-session";
        } else {
          page.window["__openclawMeetChat"] = {};
        }
      });

      expect((await page.send()).status).toBe("uncertain");
      expect(page.sendButton.click).toHaveBeenCalledOnce();
    },
  );

  it.each(["aria-pressed", "aria-expanded"])(
    "leaves a loading open chat panel open when its unread-suffix toggle has %s set",
    async (attribute) => {
      const page = chatPage();
      page.document.composers = [];
      page.toggle.attributes["aria-label"] = "Chat with everyone (2 unread messages)";
      page.toggle.attributes[attribute] = "true";
      page.onWait.mockImplementationOnce(() => {
        page.document.composers = [page.composer];
      });
      page.acceptSend();

      expect((await page.send()).status).toBe("succeeded");
      expect(page.toggle.click).not.toHaveBeenCalled();
      expect(page.sendButton.click).toHaveBeenCalledOnce();
    },
  );

  it("opens a closed chat panel through its unread-suffix toggle", async () => {
    const page = chatPage();
    page.document.composers = [];
    page.toggle.attributes["aria-label"] = "In-call messages, 2 unread";
    page.toggle.click.mockImplementation(() => {
      page.document.composers = [page.composer];
    });
    page.acceptSend();

    expect((await page.send()).status).toBe("succeeded");
    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(page.sendButton.click).toHaveBeenCalledOnce();
  });

  it("does not treat an empty replacement composer as editor acceptance", async () => {
    const page = chatPage();
    page.onWait.mockImplementationOnce(() => {
      page.composer.value = "";
      page.composer.isConnected = false;
      page.document.composers = [new Composer(page.document)];
    });

    expect((await page.send()).status).toBe("uncertain");
    expect(page.sendButton.click).toHaveBeenCalledOnce();
    expect(page.document.composers[0]?.dispatchEvent).not.toHaveBeenCalled();
  });

  it("sends a reply tied to a current, newly observed native participant source", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    page.addMessage({ id: nativeMessageId(), text: "What is next?" });
    const { sources } = await readChat(page);
    const source = sources[0];
    if (!source) {
      throw new Error("Expected a current native source");
    }
    page.acceptSend();

    expect((await page.send("source-reply", MESSAGE, source)).status).toBe("succeeded");
    expect(page.sendButton.click).toHaveBeenCalledOnce();
  });

  it.each(["edited", "revised", "removed"])(
    "does not write when the original native source is %s between preparation and send",
    async (change) => {
      const page = chatPage();
      await readChat(page);
      vi.setSystemTime(STARTED_AT_MS + 1);
      const id = nativeMessageId();
      page.addMessage({ id, text: "What is next?" });
      const { sources } = await readChat(page);
      const source = sources[0];
      if (!source) {
        throw new Error("Expected a current native source");
      }
      page.acceptSend();
      page.beforeSend.mockImplementation(async () => {
        if (change === "removed") {
          page.removeMessage(id);
        } else {
          page.editMessage(id, "A different question");
          if (change === "revised") {
            await readChat(page);
          }
        }
      });

      expect((await page.send("stale-source-reply", MESSAGE, source)).status).toBe("rejected");
      expect(page.composer.focus).not.toHaveBeenCalled();
      expect(page.composer.value).toBe("");
      expect(page.sendButton.click).not.toHaveBeenCalled();
    },
  );
});

describe("meetReadChatScript", () => {
  it("reports the page epoch even when the chat contains no messages", async () => {
    const page = chatPage();

    expect(await readChat(page)).toEqual({
      status: "succeeded",
      epoch: "chat-epoch-1",
      sources: [],
      unrecognizedRows: 0,
    });
  });

  it("keeps initial messages historical and admits only a later native timestamp", async () => {
    const page = chatPage();
    page.addMessage({ id: FIRST_NATIVE_ID, text: "Earlier discussion" });

    const first = await readChat(page);
    expect(first.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true, finalized: true }),
    ]);

    vi.setSystemTime(STARTED_AT_MS + 1);
    const freshId = nativeMessageId();
    page.addMessage({ id: freshId, text: "New question" });
    const later = await readChat(page);
    expect(later.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true }),
      expect.objectContaining({ id: freshId, historical: false }),
    ]);
  });

  it("keeps delayed history inert after an initially empty snapshot", async () => {
    const page = chatPage();
    expect((await readChat(page)).sources).toEqual([]);
    vi.setSystemTime(STARTED_AT_MS + 100);
    page.addMessage({ id: FIRST_NATIVE_ID, text: "An old question loaded late" });
    const freshId = nativeMessageId();
    page.addMessage({ id: freshId, text: "A participant just asked this" });

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true }),
      expect.objectContaining({ id: freshId, historical: false }),
    ]);
    page.acceptSend();
    expect((await page.send("old-question", MESSAGE, snapshot.sources[0])).status).toBe("rejected");
    expect(page.composer.focus).not.toHaveBeenCalled();
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it.each(["loading", "ambiguous"])(
    "does not initialize the first snapshot while the composer is %s",
    async (state) => {
      const page = chatPage();
      page.document.composers =
        state === "loading" ? [] : [page.composer, new Composer(page.document)];
      page.toggle.attributes["aria-pressed"] = "true";
      page.addMessage({ id: FIRST_NATIVE_ID, text: "History during loading" });

      expect((await page.read()).status).toBe("rejected");
      expect(page.toggle.click).not.toHaveBeenCalled();
      vi.setSystemTime(STARTED_AT_MS + 10);
      const duringLoadingId = nativeMessageId();
      page.addMessage({ id: duringLoadingId, text: "Arrived before the panel was ready" });
      page.document.composers = [page.composer];

      const first = await readChat(page);

      expect(first.sources).toEqual([
        expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true }),
        expect.objectContaining({ id: duringLoadingId, historical: true }),
      ]);
      vi.setSystemTime(STARTED_AT_MS + 11);
      const freshId = nativeMessageId();
      page.addMessage({ id: freshId, text: "Arrived after the panel was ready" });
      expect((await readChat(page)).sources).toContainEqual(
        expect.objectContaining({ id: freshId, historical: false }),
      );
    },
  );

  it("keeps the original cutoff when chat closes and reopens", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 10);
    const beforeReopenId = nativeMessageId();
    page.document.composers = [];
    page.toggle.click.mockImplementation(() => {
      vi.setSystemTime(STARTED_AT_MS + 20);
      page.addMessage({ id: FIRST_NATIVE_ID, text: "Late history" });
      page.addMessage({ id: beforeReopenId, text: "A new question while chat was closed" });
      page.document.composers = [page.composer];
    });

    const reopened = await readChat(page);

    expect(page.toggle.click).toHaveBeenCalledOnce();
    expect(reopened.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true }),
      expect.objectContaining({ id: beforeReopenId, historical: false }),
    ]);
  });

  it("captures the cutoff before an initially empty panel finishes opening", async () => {
    const page = chatPage();
    page.document.composers = [];
    page.toggle.attributes["aria-pressed"] = "true";
    page.onWait.mockImplementationOnce(() => {
      vi.setSystemTime(STARTED_AT_MS + 10);
      page.document.composers = [page.composer];
    });
    expect((await readChat(page)).sources).toEqual([]);
    const duringOpeningId = nativeMessageId(STARTED_AT_MS + 5);
    page.addMessage({ id: FIRST_NATIVE_ID, text: "History older than the observation" });
    page.addMessage({ id: duringOpeningId, text: "Created during opening, rendered later" });

    expect((await readChat(page)).sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, historical: true }),
      expect.objectContaining({ id: duringOpeningId, historical: false }),
    ]);
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the bootstrap timestamp", id: nativeMessageId(STARTED_AT_MS) },
    { name: "the rest of the bootstrap millisecond", id: nativeMessageId(STARTED_AT_MS, 999) },
    { name: "a nonnumeric suffix", id: "spaces/test/messages/unknown" },
    { name: "a short numeric suffix", id: "spaces/test/messages/123456789012345" },
    { name: "a long numeric suffix", id: "spaces/test/messages/12345678901234567" },
    { name: "an unsafe integer suffix", id: "spaces/test/messages/9999999999999999" },
    { name: "a future timestamp", id: nativeMessageId(STARTED_AT_MS + 100) },
  ])("never grants reply authority to $name, even on a later revision", async ({ id }) => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    page.addMessage({ id, text: "Do not answer this row" });

    const first = await readChat(page);
    expect(first.sources).toEqual([
      expect.objectContaining({ id, revision: "1", historical: true }),
    ]);
    vi.setSystemTime(STARTED_AT_MS + 1_000);
    page.editMessage(id, "An edit cannot make this fresh");
    const revised = await readChat(page);
    expect(revised.sources).toEqual([
      expect.objectContaining({ id, revision: "2", historical: true }),
    ]);
    page.acceptSend();
    expect((await page.send("inert-source", MESSAGE, revised.sources[0])).status).toBe("rejected");
    expect(page.composer.focus).not.toHaveBeenCalled();
    expect(page.composer.value).toBe("");
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it("ignores a malformed native message path", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    page.addMessage({ id: `${nativeMessageId()}/extra`, text: "Malformed identity" });

    expect((await readChat(page)).sources).toEqual([]);
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it("admits microseconds within the current later millisecond", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    const id = nativeMessageId(Date.now(), 999);
    page.addMessage({ id, text: "A fresh native question" });

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([expect.objectContaining({ id, historical: false })]);
    page.acceptSend();
    expect((await page.send("fresh-source", MESSAGE, snapshot.sources[0])).status).toBe(
      "succeeded",
    );
    expect(page.sendButton.click).toHaveBeenCalledOnce();
  });

  it("keeps a future ID historical after its source record is evicted and the row reappears", async () => {
    const page = chatPage();
    await readChat(page);
    const futureId = nativeMessageId(STARTED_AT_MS + 100);
    vi.setSystemTime(STARTED_AT_MS + 1);
    page.addMessage({ id: futureId, text: "Initially a future timestamp" });
    expect((await readChat(page)).sources[0]).toMatchObject({ id: futureId, historical: true });
    page.removeMessage(futureId);

    const oldIds: string[] = [];
    for (let batch = 0; batch < 2; batch += 1) {
      for (let index = 0; index < 128; index += 1) {
        const id = nativeMessageId(STARTED_AT_MS - 1_000 - batch * 128 - index);
        oldIds.push(id);
        page.addMessage({
          id,
          text: `Old row ${batch * 128 + index}`,
        });
      }
      await readChat(page);
    }
    const state = page.window["__openclawMeetChat"] as { messages: Map<string, unknown> };
    expect(state.messages.has(futureId)).toBe(false);
    for (const id of oldIds) {
      page.removeMessage(id);
    }
    vi.setSystemTime(STARTED_AT_MS + 101);
    page.addMessage({ id: futureId, text: "Reappeared after its timestamp passed" });

    const source = (await readChat(page)).sources.find((entry) => entry.id === futureId);

    expect(source).toMatchObject({ id: futureId, historical: true });
    page.acceptSend();
    expect((await page.send("evicted-source", MESSAGE, source)).status).toBe("rejected");
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it("remembers an unrecognized future row before its sender shape becomes usable", async () => {
    const page = chatPage();
    await readChat(page);
    const id = nativeMessageId(STARTED_AT_MS + 100);
    vi.setSystemTime(STARTED_AT_MS + 1);
    const row = page.addMessage({ id, text: "Future row with an unknown sender shape" });
    row.body.attributes.class = "jO4O1 chmVPb";
    expect((await readChat(page)).sources).toEqual([]);
    vi.setSystemTime(STARTED_AT_MS + 101);
    row.body.attributes.class = "jO4O1";

    const source = (await readChat(page)).sources[0];

    expect(source).toMatchObject({ id, historical: true, ownEcho: false });
    page.acceptSend();
    expect((await page.send("unknown-future-source", MESSAGE, source)).status).toBe("rejected");
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it("stops admitting new sources when exceptional history retention reaches capacity", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    const admittedId = nativeMessageId();
    page.addMessage({ id: admittedId, text: "An already admitted question" });
    const admitted = (await readChat(page)).sources[0];
    expect(admitted).toMatchObject({ id: admittedId, historical: false });
    const state = page.window["__openclawMeetChat"] as { historicalIds: Set<string> };
    for (let index = 0; index < 1_024; index += 1) {
      state.historicalIds.add(nativeMessageId(STARTED_AT_MS + 100 + index));
    }
    page.addMessage({ id: nativeMessageId(STARTED_AT_MS + 100_000), text: "One more future ID" });
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 2);
    const newId = nativeMessageId();
    page.addMessage({ id: newId, text: "Do not admit beyond retention capacity" });

    const snapshot = await readChat(page);
    const newcomer = snapshot.sources.find((source) => source.id === newId);

    expect(newcomer).toMatchObject({ historical: true });
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({ id: admittedId, historical: false }),
    );
    page.acceptSend();
    expect((await page.send("capacity-newcomer", MESSAGE, newcomer)).status).toBe("rejected");
    expect(page.sendButton.click).not.toHaveBeenCalled();
    expect((await page.send("previously-admitted", MESSAGE, admitted)).status).toBe("succeeded");
    expect(page.sendButton.click).toHaveBeenCalledOnce();
  });

  it("records ownership lost during panel opening and rebaselines when the call returns", async () => {
    const page = chatPage();
    const initial = await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    const id = nativeMessageId();
    page.addMessage({ id, text: "Question before ownership was lost" });
    const previous = (await readChat(page)).sources[0];
    const buttons = page.document.buttons;
    page.document.composers = [];
    page.toggle.attributes["aria-pressed"] = "true";
    page.onWait.mockImplementationOnce(() => {
      page.document.buttons = buttons.filter(
        (button) => button.getAttribute("aria-label") !== "Leave call",
      );
    });

    expect((await page.read()).status).toBe("rejected");
    vi.setSystemTime(STARTED_AT_MS + 10);
    page.document.buttons = buttons;
    page.document.composers = [page.composer];
    const returned = await readChat(page);

    expect(returned.epoch).not.toBe(initial.epoch);
    expect(returned.sources).toEqual([
      expect.objectContaining({ id, epoch: returned.epoch, historical: true }),
    ]);
    page.acceptSend();
    expect((await page.send("lost-during-open", MESSAGE, previous)).status).toBe("rejected");
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });

  it("starts a new history baseline after an observed disconnection and rejects the old source", async () => {
    const page = chatPage();
    await readChat(page);
    vi.setSystemTime(STARTED_AT_MS + 1);
    const previousId = nativeMessageId();
    page.addMessage({ id: previousId, text: "Question from the previous connection" });
    const previous = await readChat(page);
    const previousSource = previous.sources[0];
    if (!previousSource) {
      throw new Error("Expected a source before the disconnection");
    }
    expect(previousSource.historical).toBe(false);
    const buttons = page.document.buttons;
    page.document.buttons = buttons.filter(
      (button) => button.getAttribute("aria-label") !== "Leave call",
    );

    expect((await page.read()).status).toBe("rejected");
    vi.setSystemTime(STARTED_AT_MS + 10);
    page.document.buttons = buttons;
    const reconnected = await readChat(page);

    expect(reconnected.epoch).not.toBe(previous.epoch);
    expect(reconnected.sources).toEqual([
      expect.objectContaining({ id: previousId, epoch: reconnected.epoch, historical: true }),
    ]);
    page.acceptSend();
    expect((await page.send("old-connection", MESSAGE, previousSource)).status).toBe("rejected");
    expect(page.composer.focus).not.toHaveBeenCalled();
    expect(page.sendButton.click).not.toHaveBeenCalled();

    const duringDisconnectId = nativeMessageId(STARTED_AT_MS + 5);
    page.addMessage({
      id: duringDisconnectId,
      text: "Delayed history from the disconnected interval",
    });
    vi.setSystemTime(STARTED_AT_MS + 11);
    const currentId = nativeMessageId();
    page.addMessage({ id: currentId, text: "Question from the current connection" });
    const current = await readChat(page);
    expect(current.sources).toContainEqual(
      expect.objectContaining({ id: duringDisconnectId, historical: true }),
    );
    const currentSource = current.sources.find((source) => source.id === currentId);
    expect(currentSource).toMatchObject({ epoch: reconnected.epoch, historical: false });
    expect((await page.send("current-connection", MESSAGE, currentSource)).status).toBe(
      "succeeded",
    );
    expect(page.sendButton.click).toHaveBeenCalledOnce();
  });

  it("keeps identical peer texts separate and ignores nested Pin controls repeating their IDs", async () => {
    const page = chatPage();
    const first = page.addMessage({
      id: FIRST_NATIVE_ID,
      text: "Same message",
      groupId: "peer-group",
      speaker: "Participant",
    });
    const second = page.addMessage({
      id: SECOND_NATIVE_ID,
      text: "Same message",
      groupId: "peer-group",
      speaker: "Participant",
    });
    expect(first.group).toBe(second.group);
    expect(page.document.querySelectorAll("[data-message-id]")).toHaveLength(4);

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        id: FIRST_NATIVE_ID,
        revision: "1",
        text: "Same message",
        ownEcho: false,
      }),
      expect.objectContaining({
        id: SECOND_NATIVE_ID,
        revision: "1",
        text: "Same message",
        ownEcho: false,
      }),
    ]);
    expect(snapshot.unrecognizedRows).toBe(0);
    expect(first.pin.click).not.toHaveBeenCalled();
    expect(second.pin.click).not.toHaveBeenCalled();
  });

  it("preserves native identity, revision, epoch, and timestamp on unchanged polls", async () => {
    const page = chatPage();
    page.addMessage({ id: FIRST_NATIVE_ID, text: "Stable message" });

    const first = await readChat(page);
    const repeated = await readChat(page);

    expect(repeated.sources).toEqual(first.sources);
    expect(first.sources).toEqual([
      expect.objectContaining({
        id: FIRST_NATIVE_ID,
        revision: "1",
        epoch: "chat-epoch-1",
        at: expect.any(String),
      }),
    ]);
  });

  it("increments the revision of an edited message without replacing its native ID", async () => {
    const page = chatPage();
    page.addMessage({ id: FIRST_NATIVE_ID, text: "Original text" });
    await readChat(page);
    page.editMessage(FIRST_NATIVE_ID, "Corrected text");

    const revised = await readChat(page);

    expect(revised.sources).toEqual([
      expect.objectContaining({
        id: FIRST_NATIVE_ID,
        revision: "2",
        text: "Corrected text",
        historical: true,
      }),
    ]);
    expect((await readChat(page)).sources).toEqual(revised.sources);
  });

  it("uses native own-row markers rather than a peer's matching display name", async () => {
    const page = chatPage();
    const peer = page.addMessage({
      id: FIRST_NATIVE_ID,
      text: "A peer message",
      speaker: "Shared display name",
    });
    const own = page.addMessage({
      id: SECOND_NATIVE_ID,
      text: "Our message",
      speaker: "Shared display name",
      ownEcho: true,
    });
    expect(peer.header.querySelector(".poVWob")?.textContent).toBe("Shared display name");
    expect(own.header.querySelector(".poVWob")).toBeNull();

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        id: FIRST_NATIVE_ID,
        ownEcho: false,
        speaker: "Shared display name",
      }),
      expect.objectContaining({ id: SECOND_NATIVE_ID, ownEcho: true }),
    ]);
    expect(snapshot.sources[1]?.speaker).toBeUndefined();
  });

  it("excludes an unrecognized row instead of inferring participant identity", async () => {
    const page = chatPage();
    const message = page.addMessage({ id: FIRST_NATIVE_ID, text: "Ambiguous sender" });
    message.body.attributes.class = "jO4O1 chmVPb";

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([]);
    expect(snapshot.unrecognizedRows).toBe(1);
  });

  it("revokes an already observed source when its row shape becomes contradictory", async () => {
    const page = chatPage();
    const message = page.addMessage({ id: FIRST_NATIVE_ID, text: "Known participant" });
    await readChat(page);
    message.body.attributes.class = "jO4O1 chmVPb";

    const snapshot = await readChat(page);

    expect(snapshot.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, revision: "2", text: "", finalized: false }),
    ]);
    expect(snapshot.sources[0]?.ownEcho).toBeUndefined();
    expect(snapshot.unrecognizedRows).toBe(1);
  });

  it("emits one invalidating tombstone when a native row disappears", async () => {
    const page = chatPage();
    page.addMessage({ id: FIRST_NATIVE_ID, text: "Removed message" });
    await readChat(page);
    page.removeMessage(FIRST_NATIVE_ID);

    const removed = await readChat(page);

    expect(removed.sources).toEqual([
      expect.objectContaining({ id: FIRST_NATIVE_ID, revision: "2", text: "", finalized: false }),
    ]);
    expect((await readChat(page)).sources).toEqual([]);
  });

  it.each(["session", "url"])("rejects chat reads after the %s changes", async (change) => {
    const page = chatPage();
    page.addMessage({ id: FIRST_NATIVE_ID, text: "Do not observe this" });
    if (change === "session") {
      page.window["__openclawMeetAudioSession"] = "another-session";
    } else {
      page.location.href = "https://meet.google.com/klm-nopq-rst";
    }

    expect((await page.read()).status).toBe("rejected");
    expect(page.window["__openclawMeetChat"]).toBeUndefined();
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.sendButton.click).not.toHaveBeenCalled();
  });
});
