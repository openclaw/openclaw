import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explicitlyRequestsMeetChatVoice,
  GoogleMeetChatObserver,
  type GoogleMeetChatSnapshot,
  type GoogleMeetChatSource,
} from "./google-meet-chat.js";

const SESSION_ID = "meeting-1";
type ObserverOptions = ConstructorParameters<typeof GoogleMeetChatObserver>[0];
type ReplyResult = Awaited<ReturnType<ObserverOptions["reply"]>>;
const observers: GoogleMeetChatObserver[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const observer of observers.splice(0)) {
    observer.stop(SESSION_ID);
  }
  vi.useRealTimers();
});

function chatSource(overrides: Partial<GoogleMeetChatSource> = {}): GoogleMeetChatSource {
  return {
    id: "native-message-1",
    epoch: "chat-epoch-1",
    revision: "1",
    kind: "chat",
    text: "What is the next step?",
    ownEcho: false,
    finalized: true,
    ...overrides,
  };
}

function sourceHandle(source: GoogleMeetChatSource): string {
  return JSON.stringify([source.epoch, source.id, source.revision]);
}

function chatSnapshot(sources: GoogleMeetChatSource[]): GoogleMeetChatSnapshot {
  return { epoch: sources[0]?.epoch ?? "chat-epoch-1", sources };
}

function observerFixture(sources = [chatSource()]) {
  const currentSources = new Map<string, string>();
  let currentEpoch: string | undefined;
  const isActive = vi.fn<ObserverOptions["isActive"]>().mockReturnValue(true);
  const autoReply = vi.fn<ObserverOptions["autoReply"]>().mockReturnValue(true);
  const read = vi.fn<ObserverOptions["read"]>().mockResolvedValue(chatSnapshot(sources));
  const observeEpoch = vi.fn<ObserverOptions["observeEpoch"]>((_sessionId, epoch) => {
    if (epoch !== currentEpoch) {
      currentSources.clear();
      currentEpoch = epoch;
    }
    return true;
  });
  const observe = vi.fn<ObserverOptions["observe"]>((_sessionId, source) => {
    const key = JSON.stringify([source.epoch, source.id]);
    currentSources.delete(key);
    if (!source.finalized || source.ownEcho !== false || !source.text.trim()) {
      return undefined;
    }
    const handle = sourceHandle(source);
    currentSources.set(key, handle);
    return handle;
  });
  const assertCurrent = vi.fn<ObserverOptions["assertCurrent"]>((_sessionId, sourceId) => {
    if (![...currentSources.values()].includes(sourceId)) {
      throw new Error("source revoked");
    }
  });
  const consult = vi.fn<ObserverOptions["consult"]>().mockResolvedValue("Review the proposal.");
  const reply = vi.fn<ObserverOptions["reply"]>().mockResolvedValue({ status: "succeeded" });
  const onError = vi.fn<ObserverOptions["onError"]>();
  const observer = new GoogleMeetChatObserver({
    isActive,
    autoReply,
    read,
    observeEpoch,
    observe,
    assertCurrent,
    consult,
    reply,
    onError,
  });
  observers.push(observer);
  const start = async () => {
    void observer.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    observer,
    isActive,
    autoReply,
    read,
    observeEpoch,
    observe,
    assertCurrent,
    consult,
    reply,
    onError,
    currentSources,
    start,
  };
}

describe("explicitlyRequestsMeetChatVoice", () => {
  it.each<[string, boolean]>([
    ["Please reply aloud with the next step.", true],
    ["Read the summary out loud.", true],
    ["Can you respond by voice?", true],
    ["Reply aloud; do not include names.", true],
    ["Agent, can you read the results aloud?", true],
    ["I want you to reply aloud.", true],
    ["Why did you answer out loud?", false],
    ["They say the results out loud.", false],
    ['The phrase is "say this aloud".', false],
    ["What is the next step?", false],
    ["Reply in chat.", false],
    ["Do not reply aloud.", false],
    ["Don't speak out loud.", false],
    ["Please reply in writing, not aloud.", false],
    ["No voice; answer in chat.", false],
  ])("derives voice permission from %j", (text, expected) => {
    expect(explicitlyRequestsMeetChatVoice(text)).toBe(expected);
  });
});

describe("GoogleMeetChatObserver", () => {
  it("defaults to a written reply even when the model answer mentions speaking", async () => {
    const source = chatSource();
    const page = observerFixture([source]);
    page.consult.mockResolvedValue("Say this aloud: review the proposal.");

    await page.start();

    expect(page.consult).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      source,
      context: [source],
      signal: expect.any(AbortSignal),
    });
    expect(page.reply).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION_ID,
      sourceId: sourceHandle(source),
      requestId: `chat-reply:${sourceHandle(source)}`,
      text: "Say this aloud: review the proposal.",
      output: "chat",
    });
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("answers an explicit participant voice request once", async () => {
    const source = chatSource({ text: "Please reply out loud with the next step." });
    const page = observerFixture([source]);

    await page.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceId: sourceHandle(source), output: "voice" }),
    );
  });

  it("keeps a negative voice request in chat", async () => {
    const page = observerFixture([chatSource({ text: "Please answer in chat, not aloud." })]);

    await page.start();

    expect(page.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ output: "chat" }));
  });

  it.each(["NO_REPLY", " \nNO_REPLY\n", "", " \n "])(
    "leaves the meeting silent for a model answer of %j",
    async (answer) => {
      const page = observerFixture();
      page.consult.mockResolvedValue(answer);

      await page.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(page.consult).toHaveBeenCalledOnce();
      expect(page.reply).not.toHaveBeenCalled();
      expect(page.onError).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "self echoes", ownEcho: true },
    { name: "messages with unknown self identity", ownEcho: undefined },
  ])("observes $name without asking the model to answer them", async ({ ownEcho }) => {
    const source = chatSource({ ownEcho });
    const page = observerFixture([source]);

    await page.start();

    expect(page.observe).toHaveBeenCalledWith(SESSION_ID, source);
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();
  });

  it("keeps observing when automatic replies are disabled for transcribe mode", async () => {
    const source = chatSource({ text: "Please reply aloud with the next step." });
    const page = observerFixture([source]);
    page.autoReply.mockReturnValue(false);

    await page.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.read).toHaveBeenCalledTimes(3);
    expect(page.observe).toHaveBeenCalledWith(SESSION_ID, source);
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("does not turn historical messages into current reply authority", async () => {
    const page = observerFixture([chatSource({ historical: true })]);

    await page.start();

    expect(page.observeEpoch).toHaveBeenCalledWith(SESSION_ID, "chat-epoch-1");
    expect(page.observe).not.toHaveBeenCalled();
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();
  });

  it("ignores delayed historical questions after an empty read and answers only a fresh source", async () => {
    const page = observerFixture([]);
    await page.start();
    const historical = chatSource({
      id: "historical-message",
      historical: true,
      text: "Please answer the old question aloud.",
    });
    page.read.mockResolvedValue(chatSnapshot([historical]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.observe).not.toHaveBeenCalled();
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();

    const fresh = chatSource({ id: "fresh-message", text: "What should we do now?" });
    page.read.mockResolvedValue(chatSnapshot([historical, fresh]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.observe).toHaveBeenCalledExactlyOnceWith(SESSION_ID, fresh);
    expect(page.consult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: fresh }),
    );
    expect(page.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceId: sourceHandle(fresh), output: "chat" }),
    );
  });

  it("does not repeat a consultation for an unchanged polled message", async () => {
    const page = observerFixture();

    await page.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(page.read).toHaveBeenCalledTimes(4);
    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)(
    "does not wait for a canceled consult that will later %s before answering current questions",
    async (lateOutcome) => {
      const original = chatSource();
      const revised = chatSource({ revision: "2", text: "What is the next step after approval?" });
      const second = chatSource({ id: "native-message-2", text: "Who owns the rollout?" });
      const page = observerFixture([original]);
      const originalAnswer = createDeferred<string>();
      page.consult
        .mockReturnValueOnce(originalAnswer.promise)
        .mockResolvedValueOnce("Begin the rollout.")
        .mockResolvedValueOnce("The release owner.");

      try {
        await page.start();
        const originalSignal = page.consult.mock.calls[0]?.[0].signal;
        expect(originalSignal?.aborted).toBe(false);

        page.read.mockResolvedValue(chatSnapshot([revised, second]));
        await vi.advanceTimersByTimeAsync(1_000);

        expect(originalSignal?.aborted).toBe(true);
        expect(() => page.assertCurrent(SESSION_ID, sourceHandle(original))).toThrow(
          "source revoked",
        );
        expect(page.consult.mock.calls.map(([params]) => sourceHandle(params.source))).toEqual([
          sourceHandle(original),
          sourceHandle(revised),
          sourceHandle(second),
        ]);
        expect(
          page.reply.mock.calls.map(([params]) => ({
            sourceId: params.sourceId,
            text: params.text,
          })),
        ).toEqual([
          { sourceId: sourceHandle(revised), text: "Begin the rollout." },
          { sourceId: sourceHandle(second), text: "The release owner." },
        ]);

        if (lateOutcome === "resolve") {
          originalAnswer.resolve("Outdated answer");
        } else {
          originalAnswer.reject(new Error("Canceled consultation failed later"));
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(page.reply).toHaveBeenCalledTimes(2);
        expect(page.onError).not.toHaveBeenCalled();
      } finally {
        originalAnswer.resolve("Late obsolete answer");
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("retires a pending consult when the owner rejects its unchanged source", async () => {
    const original = chatSource();
    const second = chatSource({ id: "native-message-2", text: "What can we do now?" });
    const page = observerFixture([original]);
    const originalAnswer = createDeferred<string>();
    page.consult.mockReturnValueOnce(originalAnswer.promise).mockResolvedValueOnce("Review now.");
    const observe = page.observe.getMockImplementation();
    if (!observe) {
      throw new Error("Expected the live-source admission fixture.");
    }
    try {
      await page.start();
      const signal = page.consult.mock.calls[0]?.[0].signal;
      page.observe.mockImplementation((sessionId, source) => {
        if (source.id === original.id) {
          page.currentSources.delete(JSON.stringify([source.epoch, source.id]));
          return undefined;
        }
        return observe(sessionId, source);
      });
      page.read.mockResolvedValue(chatSnapshot([original, second]));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(signal?.aborted).toBe(true);
      expect(page.consult).toHaveBeenCalledTimes(2);
      expect(page.reply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sourceId: sourceHandle(second), text: "Review now." }),
      );
    } finally {
      originalAnswer.resolve("Expired answer");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(page.reply).toHaveBeenCalledOnce();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("aborts a pending answer when an empty snapshot arrives from a new page epoch", async () => {
    const original = chatSource();
    const page = observerFixture([original]);
    const answer = createDeferred<string>();
    page.consult.mockReturnValueOnce(answer.promise);
    await page.start();
    const signal = page.consult.mock.calls[0]?.[0].signal;

    page.read.mockResolvedValue({ epoch: "chat-epoch-2", sources: [] });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.observeEpoch).toHaveBeenLastCalledWith(SESSION_ID, "chat-epoch-2");
    expect(signal?.aborted).toBe(true);
    expect(() => page.assertCurrent(SESSION_ID, sourceHandle(original))).toThrow("source revoked");
    answer.resolve("Answer from the previous page");
    await vi.advanceTimersByTimeAsync(0);

    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a removal tombstone", ownEcho: false },
    { name: "an unknown sender shape", ownEcho: undefined },
  ])("aborts a pending answer when its source becomes $name", async ({ ownEcho }) => {
    const original = chatSource();
    const invalidated = chatSource({ revision: "2", finalized: false, text: "", ownEcho });
    const page = observerFixture([original]);
    const answer = createDeferred<string>();
    page.consult.mockReturnValueOnce(answer.promise);
    await page.start();
    const signal = page.consult.mock.calls[0]?.[0].signal;

    page.read.mockResolvedValue(chatSnapshot([invalidated]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.observe).toHaveBeenLastCalledWith(SESSION_ID, invalidated);
    expect(page.observe.mock.results.at(-1)?.value).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(() => page.assertCurrent(SESSION_ID, sourceHandle(original))).toThrow("source revoked");
    answer.resolve("Answer for the invalidated message");
    await vi.advanceTimersByTimeAsync(0);

    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("serializes consultations and effects while polling continues", async () => {
    const first = chatSource();
    const second = chatSource({ id: "native-message-2", text: "Who owns the rollout?" });
    const page = observerFixture([first, second]);
    const firstAnswer = createDeferred<string>();
    const firstEffect = createDeferred<ReplyResult>();
    page.consult
      .mockReturnValueOnce(firstAnswer.promise)
      .mockResolvedValueOnce("The release owner.");
    page.reply.mockReturnValueOnce(firstEffect.promise);

    await page.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.read).toHaveBeenCalledTimes(2);
    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).not.toHaveBeenCalled();

    firstAnswer.resolve("Review the proposal.");
    await vi.advanceTimersByTimeAsync(0);

    expect(page.reply).toHaveBeenCalledOnce();
    expect(page.consult).toHaveBeenCalledOnce();

    // Cancellation releases only read-only consultation, never an admitted native effect.
    page.read.mockResolvedValue(
      chatSnapshot([{ ...first, revision: "2", text: "A changed request" }, second]),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.consult.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).toHaveBeenCalledOnce();

    firstEffect.resolve({ status: "uncertain" });
    await vi.advanceTimersByTimeAsync(0);

    expect(page.consult.mock.calls.map(([params]) => params.source.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(page.reply.mock.calls.map(([params]) => params.sourceId)).toEqual([
      sourceHandle(first),
      sourceHandle(second),
    ]);
  });

  it("rechecks the owner after a model answer even without another observer poll", async () => {
    const page = observerFixture();
    const answer = createDeferred<string>();
    page.consult.mockReturnValueOnce(answer.promise);
    await page.start();

    page.currentSources.clear();
    answer.resolve("This source has expired.");
    await vi.advanceTimersByTimeAsync(0);

    expect(page.reply).not.toHaveBeenCalled();
    expect(page.onError).toHaveBeenCalledExactlyOnceWith(SESSION_ID, expect.any(Error));
  });

  it.each(["succeeded", "uncertain"] as const)(
    "does not reopen an attempted reply on later revisions after a %s effect",
    async (status) => {
      const page = observerFixture();
      page.reply.mockResolvedValue({ status });
      await page.start();

      page.read.mockResolvedValue(
        chatSnapshot([chatSource({ revision: "2", text: "An edited question" })]),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      page.read.mockResolvedValue(
        chatSnapshot([chatSource({ revision: "3", text: "Another edit" })]),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(page.observe).toHaveBeenCalledTimes(3);
      expect(page.consult).toHaveBeenCalledOnce();
      expect(page.reply).toHaveBeenCalledOnce();
      expect(page.onError).toHaveBeenCalledTimes(status === "succeeded" ? 0 : 1);
    },
  );

  it("stops pending and queued consultations before they can reply", async () => {
    const page = observerFixture([chatSource(), chatSource({ id: "native-message-2" })]);
    const answer = createDeferred<string>();
    page.consult.mockReturnValueOnce(answer.promise);
    await page.start();
    const signal = page.consult.mock.calls[0]?.[0].signal;

    page.observer.stop(SESSION_ID);
    answer.resolve("Too late to send");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(signal?.aborted).toBe(true);
    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.read).toHaveBeenCalledOnce();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("ignores an in-flight read that finishes after the observer stops", async () => {
    const page = observerFixture();
    const read = createDeferred<GoogleMeetChatSnapshot>();
    page.read.mockReturnValueOnce(read.promise);
    await page.start();

    page.observer.stop(SESSION_ID);
    read.resolve(chatSnapshot([chatSource()]));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.observe).not.toHaveBeenCalled();
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.read).toHaveBeenCalledOnce();
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("stops itself when the session retires during an in-flight read", async () => {
    const page = observerFixture();
    const read = createDeferred<GoogleMeetChatSnapshot>();
    page.read.mockReturnValueOnce(read.promise);
    await page.start();

    page.isActive.mockReturnValue(false);
    read.resolve(chatSnapshot([chatSource()]));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(page.observe).not.toHaveBeenCalled();
    expect(page.consult).not.toHaveBeenCalled();
    expect(page.reply).not.toHaveBeenCalled();
    expect(page.read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(page.onError).not.toHaveBeenCalled();
  });

  it("does not let a stopped read cancel an observer restarted with the same session ID", async () => {
    const current = chatSource({ id: "current-message" });
    const page = observerFixture([current]);
    const oldRead = createDeferred<GoogleMeetChatSnapshot>();
    page.read.mockReturnValueOnce(oldRead.promise);
    await page.start();

    page.observer.stop(SESSION_ID);
    await page.start();
    oldRead.resolve(chatSnapshot([chatSource({ id: "old-message" })]));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(page.read).toHaveBeenCalledTimes(3);
    expect(page.consult).toHaveBeenCalledOnce();
    expect(page.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceId: sourceHandle(current) }),
    );
    expect(page.onError).not.toHaveBeenCalled();
  });
});
