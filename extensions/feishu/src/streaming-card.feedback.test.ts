// Exercise visible feedback and finalization through the real streaming session.
// The CardKit transport is fixed external I/O; live Feishu rendering is separate proof.
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuStreamingSession } from "./streaming-card.js";

const NOW = Date.parse("2026-10-13T01:00:00.000Z");
const CARD_PATH = "/open-apis/cardkit/v1/cards/card_feedback";
const ACKNOWLEDGEMENT = "Received, processing…";

type CardKitRequest = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  time: number;
};

type CardDocument = {
  body: { elements: Array<{ element_id?: string; content?: string }> };
  config: { summary: { content: string } };
};

let accountCounter = 0;
const sessions: FeishuStreamingSession[] = [];

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function isContentWrite(request: CardKitRequest): boolean {
  return /^\/open-apis\/cardkit\/v1\/cards\/card_feedback\/elements\/content(?:\/content)?$/.test(
    request.path,
  );
}

function writtenText(request: CardKitRequest): string {
  if (typeof request.body.element === "string") {
    return (JSON.parse(request.body.element) as { content: string }).content;
  }
  return String(request.body.content);
}

function createFixture(options?: {
  withoutMessageId?: boolean;
  onRequest?: (request: CardKitRequest) => Response | undefined | Promise<Response | undefined>;
}) {
  const requests: CardKitRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => {
    const request: CardKitRequest = {
      path: new URL(params.url).pathname,
      method: params.init?.method ?? "GET",
      body: JSON.parse(typeof params.init?.body === "string" ? params.init.body : "{}") as Record<
        string,
        unknown
      >,
      time: Date.now(),
    };
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      let response = await options?.onRequest?.(request);
      if (!response) {
        if (request.path.includes("/auth/")) {
          response = jsonResponse({
            code: 0,
            msg: "ok",
            tenant_access_token: "synthetic-token",
            expire: 7_200,
          });
        } else if (request.path === "/open-apis/cardkit/v1/cards") {
          response = jsonResponse({ code: 0, msg: "ok", data: { card_id: "card_feedback" } });
        } else if (
          isContentWrite(request) ||
          request.path === `${CARD_PATH}/elements/note/content` ||
          request.path === `${CARD_PATH}/settings`
        ) {
          response = jsonResponse({ code: 0, msg: "ok" });
        } else {
          throw new Error(`Unexpected Feishu request: ${request.path}`);
        }
      }
      return { response, finalUrl: params.url, release: async () => undefined };
    } finally {
      inFlight -= 1;
    }
  });

  const create = vi.fn(async () => ({
    code: 0,
    msg: "ok",
    data: options?.withoutMessageId ? {} : { message_id: "om_feedback" },
  }));
  const remove = vi.fn(async () => ({ code: 0, msg: "ok" }));
  const client = {
    im: { message: { create, delete: remove } },
  } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
  const log = vi.fn();
  const session = new FeishuStreamingSession(
    client,
    { appId: `feedback-${++accountCounter}`, appSecret: "synthetic-secret" },
    log,
  );
  sessions.push(session);

  return {
    session,
    requests,
    create,
    remove,
    log,
    maxInFlight: () => maxInFlight,
    contentWrites: () => requests.filter(isContentWrite),
    noteWrites: () => requests.filter(({ path }) => path === `${CARD_PATH}/elements/note/content`),
    createdCard: () => {
      const request = requests.find(({ path }) => path === "/open-apis/cardkit/v1/cards");
      return JSON.parse(String(request?.body.data)) as CardDocument;
    },
    settings: () => {
      const request = requests.find(({ path }) => path === `${CARD_PATH}/settings`);
      return JSON.parse(String(request?.body.settings)) as {
        config: { streaming_mode: boolean; summary: { content: string } };
      };
    },
  };
}

describe("Feishu streaming feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      if (session.isActive()) {
        await session.discard();
      }
    }
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows an acknowledgement immediately, then replaces it with the first answer", async () => {
    const fixture = createFixture();
    await fixture.session.start("chat_feedback");

    expect(fixture.createdCard().body.elements).toContainEqual({
      tag: "markdown",
      content: ACKNOWLEDGEMENT,
      element_id: "content",
    });
    expect(fixture.createdCard().config.summary.content).toBe(ACKNOWLEDGEMENT);
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await fixture.session.update("First answer");
    expect(fixture.contentWrites()).toHaveLength(1);
    const first = fixture.contentWrites()[0]!;
    expect(first.path).toBe(`${CARD_PATH}/elements/content`);
    expect(first.method).toBe("PUT");
    expect(writtenText(first)).toBe("First answer");

    await expect(fixture.session.closeWithResult("First answer")).resolves.toEqual({
      visibleReplySent: true,
      content: "First answer",
      messageId: "om_feedback",
    });
    expect(fixture.settings().config.summary.content).toBe("First answer");
  });

  it("coalesces punctuation and large snapshots until five seconds, then flushes without another token", async () => {
    const fixture = createFixture();
    await fixture.session.start("chat_feedback");
    await fixture.session.update("Alpha");
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.session.update("Alpha!");
    await vi.advanceTimersByTimeAsync(1_000);
    const latest = "Alpha! This snapshot adds substantially more than eighteen characters.";
    await fixture.session.update(latest);

    expect(fixture.contentWrites()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fixture.contentWrites()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.contentWrites().map(writtenText)).toEqual(["Alpha", latest]);
    expect(fixture.contentWrites().map(({ time }) => time)).toEqual([NOW, NOW + 5_000]);
    expect(fixture.contentWrites()[1]?.path).toBe(`${CARD_PATH}/elements/content/content`);
    await fixture.session.closeWithResult(latest);
  });

  it("counts from the inbound message and refreshes the selected model while the answer is idle", async () => {
    const fixture = createFixture();
    await fixture.session.start("chat_feedback", "chat_id", {
      note: "agent-feedback",
      messageCreateTimeMs: NOW - 7_000,
    });
    expect(fixture.createdCard().body.elements).toContainEqual({
      tag: "markdown",
      element_id: "note",
      content: "<font color='grey'>agent-feedback ⏱ 7.0s</font>",
    });

    await fixture.session.updateNoteBase("agent-feedback · synthetic/demo-model");
    expect(fixture.noteWrites().at(-1)?.body.content).toBe(
      "<font color='grey'>agent-feedback · synthetic/demo-model ⏱ 7.0s</font>",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.noteWrites().at(-1)?.body.content).toBe(
      "<font color='grey'>agent-feedback · synthetic/demo-model ⏱ 12.0s</font>",
    );
    expect(fixture.contentWrites()).toHaveLength(0);
    await fixture.session.closeWithResult("Complete answer");
  });

  it.each([
    { name: "seconds", timestamp: (NOW - 7_000) / 1_000, elapsed: "7.0s" },
    { name: "future timestamp", timestamp: NOW + 7_000, elapsed: "0.0s" },
    { name: "invalid timestamp", timestamp: Number.NaN, elapsed: "0.0s" },
    { name: "long-running answer", timestamp: NOW - 119_000, elapsed: "1m59s" },
  ])("renders elapsed feedback for $name", async ({ timestamp, elapsed }) => {
    const fixture = createFixture();
    await fixture.session.start("chat_feedback", "chat_id", {
      note: "agent-feedback",
      messageCreateTimeMs: timestamp,
    });
    expect(
      fixture.createdCard().body.elements.find(({ element_id }) => element_id === "note"),
    ).toMatchObject({ content: `<font color='grey'>agent-feedback ⏱ ${elapsed}</font>` });
    await fixture.session.closeWithResult("");
  });

  it("serializes model and elapsed updates with a slow answer write and coalesces missed ticks", async () => {
    const started = createDeferred();
    const release = createDeferred();
    let blocked = false;
    const fixture = createFixture({
      onRequest: async (request) => {
        if (isContentWrite(request) && !blocked) {
          blocked = true;
          started.resolve();
          await release.promise;
          return jsonResponse({ code: 0, msg: "ok" });
        }
        return undefined;
      },
    });
    await fixture.session.start("chat_feedback", "chat_id", {
      note: "agent-feedback",
      messageCreateTimeMs: NOW - 7_000,
    });
    const answerUpdate = fixture.session.update("In-flight preview");
    await started.promise;

    try {
      await vi.advanceTimersByTimeAsync(15_000);
      const modelUpdate = fixture.session.updateNoteBase("agent-feedback · synthetic/demo-model");
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.noteWrites()).toHaveLength(0);
      expect(fixture.maxInFlight()).toBe(1);

      release.resolve();
      await answerUpdate;
      await modelUpdate;
      expect(fixture.noteWrites()).toHaveLength(2);
      expect(fixture.noteWrites().map(({ body }) => body.content)).toEqual([
        "<font color='grey'>agent-feedback · synthetic/demo-model ⏱ 22.0s</font>",
        "<font color='grey'>agent-feedback · synthetic/demo-model ⏱ 22.0s</font>",
      ]);
      expect(fixture.maxInFlight()).toBe(1);
      expect(
        fixture.requests
          .filter(({ path }) => path.startsWith(`${CARD_PATH}/elements/`))
          .map(({ body }) => body.sequence),
      ).toEqual([2, 3, 4]);
      await fixture.session.closeWithResult("In-flight preview");
    } finally {
      release.resolve();
      await answerUpdate;
    }
  });

  it("writes the final answer immediately and stops pending body and elapsed timers", async () => {
    const fixture = createFixture();
    await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });
    await fixture.session.update("Accepted preview");
    await vi.advanceTimersByTimeAsync(1_000);
    await fixture.session.update("Accepted preview with queued provisional text");
    expect(fixture.contentWrites()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(2);

    await expect(
      fixture.session.closeWithResult("Final answer", {
        note: "agent-feedback · synthetic/demo-model",
      }),
    ).resolves.toMatchObject({ visibleReplySent: true, content: "Final answer" });
    expect(fixture.contentWrites().map(writtenText)).toEqual(["Accepted preview", "Final answer"]);
    expect(fixture.noteWrites().at(-1)?.body.content).toBe(
      "<font color='grey'>agent-feedback · synthetic/demo-model ⏱ 1.0s</font>",
    );
    expect(fixture.settings().config).toEqual({
      streaming_mode: false,
      summary: { content: "Final answer" },
    });
    expect(vi.getTimerCount()).toBe(0);
    const requestCount = fixture.requests.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.requests).toHaveLength(requestCount);
    expect(fixture.session.isActive()).toBe(false);
  });

  it.each([false, true])(
    "stops pending feedback when discarding a card without message receipt: %s",
    async (withoutMessageId) => {
      const fixture = createFixture({ withoutMessageId });
      await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });
      await fixture.session.update("Transient preview");
      await vi.advanceTimersByTimeAsync(1_000);
      await fixture.session.update("Transient preview with queued text");

      await expect(fixture.session.discard()).resolves.toEqual({ visibleReplySent: false });
      expect(fixture.remove).toHaveBeenCalledTimes(withoutMessageId ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
      const requestCount = fixture.requests.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.requests).toHaveLength(requestCount);
      expect(fixture.session.isActive()).toBe(false);
    },
  );

  it.each(["", undefined])(
    "clears an acknowledgement for final text %s and uses a completed summary",
    async (finalText) => {
      const fixture = createFixture();
      await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });

      await expect(fixture.session.closeWithResult(finalText)).resolves.toEqual({
        visibleReplySent: false,
        messageId: "om_feedback",
      });
      expect(fixture.contentWrites()).toHaveLength(1);
      expect(fixture.contentWrites()[0]?.path).toBe(`${CARD_PATH}/elements/content`);
      expect(writtenText(fixture.contentWrites()[0]!)).toBe("");
      expect(fixture.settings().config.summary.content).toBe("Completed");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "reports only accepted answer content after a rejected final write; accepted preview: %s",
    async (acceptedPreview) => {
      const fixture = createFixture({
        onRequest: (request) => {
          if (isContentWrite(request) && writtenText(request) === "Rejected final") {
            return jsonResponse({ code: 19_002, msg: "final body rejected" });
          }
          return undefined;
        },
      });
      await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });
      if (acceptedPreview) {
        await fixture.session.update("Accepted preview");
      }
      await vi.advanceTimersByTimeAsync(1_000);
      if (acceptedPreview) {
        await fixture.session.update("Accepted preview with queued text");
      }

      await expect(fixture.session.closeWithResult("Rejected final")).rejects.toMatchObject({
        name: "FeishuStreamingFinalizationError",
        result: {
          visibleReplySent: acceptedPreview,
          ...(acceptedPreview ? { content: "Accepted preview" } : {}),
          messageId: "om_feedback",
        },
      });
      expect(fixture.settings().config.summary.content).toBe(
        acceptedPreview ? "Accepted preview" : "Completed",
      );
      expect(vi.getTimerCount()).toBe(0);
      const requestCount = fixture.requests.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.requests).toHaveLength(requestCount);
      expect(fixture.session.isActive()).toBe(false);
    },
  );

  it("keeps a rejected footer update from preventing the final answer and streaming close", async () => {
    const fixture = createFixture({
      onRequest: ({ path }) => {
        if (path === `${CARD_PATH}/elements/note/content`) {
          return jsonResponse({ code: 19_003, msg: "note rejected" });
        }
        return undefined;
      },
    });
    await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });
    await vi.advanceTimersByTimeAsync(5_000);
    await fixture.session.updateNoteBase("agent-feedback · synthetic/demo-model");

    await expect(fixture.session.closeWithResult("Final answer")).resolves.toMatchObject({
      visibleReplySent: true,
      content: "Final answer",
    });
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining("Note update failed:"));
    expect(fixture.settings().config.summary.content).toBe("Final answer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers final delivery after a footer token renewal fails", async () => {
    let tokenRequests = 0;
    const fixture = createFixture({
      onRequest: ({ path }) => {
        if (!path.includes("/auth/")) {
          return undefined;
        }
        tokenRequests += 1;
        if (tokenRequests === 2) {
          return jsonResponse({ code: 99_991_664, msg: "temporary token failure" });
        }
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: `synthetic-token-${tokenRequests}`,
          expire: tokenRequests === 1 ? 0 : 7_200,
        });
      },
    });
    await fixture.session.start("chat_feedback", "chat_id", { note: "agent-feedback" });

    await expect(
      fixture.session.updateNoteBase("agent-feedback · synthetic/demo-model"),
    ).resolves.toBeUndefined();
    expect(fixture.noteWrites()).toHaveLength(0);
    expect(fixture.log).toHaveBeenCalledWith(
      "Note update failed: Error: Token error: temporary token failure",
    );

    await expect(fixture.session.closeWithResult("Final answer")).resolves.toMatchObject({
      visibleReplySent: true,
      content: "Final answer",
    });
    expect(tokenRequests).toBe(3);
    expect(fixture.settings().config.summary.content).toBe("Final answer");
    expect(vi.getTimerCount()).toBe(0);
  });
});
