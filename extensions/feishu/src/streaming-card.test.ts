// Feishu tests cover streaming card plugin behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { jsonResponse, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { readRequestBody, stripDispatcher, writeOversizedJson } from "./http.test-support.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import {
  createStreamingSession,
  createStreamingTokenPayload,
  type StreamingFetchDeps,
} from "./streaming-card.test-support.js";

const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;
type FeishuStreamingFetch = typeof fetch;

type StreamingSessionState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
};

type StreamingRequest = {
  url: URL;
  body: string;
  req: IncomingMessage;
  res: ServerResponse;
};

const serverStops: Array<() => Promise<void>> = [];
const hermeticPublicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

async function createStreamingFetch(
  handler: (request: StreamingRequest) => void | Promise<void>,
): Promise<StreamingFetchDeps> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readRequestBody(req);
      await handler({ url, body, req, res });
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end(String(error));
    });
  });
  const port = await listenOnLoopback(server);
  serverStops.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
  return { fetchImpl: createLocalRedirectFetch(port), lookupFn: hermeticPublicLookup };
}

function createLocalRedirectFetch(port: number): FeishuStreamingFetch {
  const realFetch = globalThis.fetch.bind(globalThis);
  return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com") {
      const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
      return await realFetch(loopback, stripDispatcher(init));
    }
    return await realFetch(input, init);
  });
}

function createMemoryFetch(
  handler: (url: URL, body: string, init?: RequestInit) => Response | Promise<Response>,
): StreamingFetchDeps {
  return {
    fetchImpl: withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : "";
        return await handler(url, body, init);
      }),
    ) as FeishuStreamingFetch,
    lookupFn: hermeticPublicLookup,
  };
}

function writeJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function createActiveSession(
  deps: StreamingFetchDeps,
  options: {
    cardId: string;
    messageId?: string;
    text?: string;
    hasNote?: boolean;
    lastUpdateTime?: number;
    log?: (message: string) => void;
  },
): FeishuStreamingSession {
  const session = createStreamingSession(
    {} as never,
    { appId: options.cardId, appSecret: "secret" },
    options.log,
    deps,
  );
  const internals = session as unknown as {
    state: StreamingSessionState;
    lastUpdateTime: number;
  };
  internals.state = {
    cardId: options.cardId,
    messageId: options.messageId ?? options.cardId.replace(/^card/, "om"),
    sequence: 1,
    currentText: options.text ?? "",
    sentText: options.text ?? "",
    hasNote: options.hasNote ?? false,
  };
  internals.lastUpdateTime = options.lastUpdateTime ?? 0;
  return session;
}

function partialDelivery(content: string, details: Record<string, unknown> = {}) {
  return {
    code: "CHANNEL_PARTIAL_DELIVERY",
    deliveryResult: { visibleReplySent: true, content, ...details },
  };
}

function readSummary(body: string | undefined): string {
  return JSON.parse(JSON.parse(body ?? "{}").settings ?? "{}").config?.summary?.content ?? "";
}

describe("FeishuStreamingSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (serverStops.length > 0) {
      await serverStops.pop()?.();
    }
  });

  function mockActiveSession(
    options: Omit<Parameters<typeof createActiveSession>[1], "log">,
    failures: {
      updateIndexes?: ReadonlySet<number>;
      updateStatuses?: ReadonlyMap<number, number>;
      replaceStatuses?: ReadonlyMap<number, number>;
      bodyErrors?: Record<string, { code: number; msg: string }>;
      onSettings?: (session: FeishuStreamingSession) => void;
    } = {},
  ) {
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    const noteBodies: string[] = [];
    const settingsBodies: string[] = [];
    const log = vi.fn();
    const deps = createMemoryFetch((url, body) => {
      let status = 200;
      if (url.pathname.includes("/auth/")) {
        return jsonResponse(createStreamingTokenPayload());
      }
      if (url.pathname.includes("/elements/content/content")) {
        const updateIndex = updateBodies.length;
        updateBodies.push(body);
        if (failures.updateIndexes?.has(updateIndex)) {
          throw new Error(`content update ${updateIndex} failed`);
        }
        const failedStatus = failures.updateStatuses?.get(updateIndex);
        if (failedStatus !== undefined) {
          status = failedStatus;
        }
      } else if (url.pathname.includes("/elements/content")) {
        const replaceIndex = replaceBodies.length;
        replaceBodies.push(body);
        const failedStatus = failures.replaceStatuses?.get(replaceIndex);
        if (failedStatus !== undefined) {
          status = failedStatus;
        }
      } else if (url.pathname.includes("/elements/note/content")) {
        noteBodies.push(body);
      } else if (url.pathname.includes("/settings")) {
        settingsBodies.push(body);
        failures.onSettings?.(session);
      }
      const error = Object.entries(failures.bodyErrors ?? {}).find(([path]) =>
        url.pathname.endsWith(path),
      )?.[1];
      return jsonResponse(error ?? { code: 0, msg: "ok" }, status);
    });
    const session = createActiveSession(deps, { ...options, log });
    return {
      session,
      updateBodies,
      replaceBodies,
      noteBodies,
      settingsBodies,
      log,
    };
  }

  function mockAcceptedStreamingCard(params: {
    accountId: string;
    response?: { code: number; msg: string; data?: { message_id?: string } };
    rejectClose?: boolean;
    rejectClear?: boolean;
    tokenExpiry?: number;
  }) {
    const authTokens: string[] = [];
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        const token = `token-${authTokens.length + 1}`;
        authTokens.push(token);
        return jsonResponse({
          ...createStreamingTokenPayload(),
          ...(params.tokenExpiry !== undefined
            ? { tenant_access_token: token, expire: params.tokenExpiry }
            : {}),
        });
      }
      if (url.pathname.endsWith("/cardkit/v1/cards")) {
        return jsonResponse({ code: 0, msg: "ok", data: { card_id: "card_accepted" } });
      }
      requests.push({ path: url.pathname, body: JSON.parse(body) as Record<string, unknown> });
      return jsonResponse(
        params.rejectClose && url.pathname.endsWith("/settings")
          ? { code: 91400, msg: "close rejected" }
          : params.rejectClear && url.pathname.endsWith("/elements/content")
            ? { code: 19002, msg: "clear rejected" }
            : { code: 0, msg: "ok" },
      );
    });
    const response = params.response ?? { code: 0, msg: "ok", data: {} };
    const create = vi.fn(async () => response);
    const reply = vi.fn(async () => response);
    const remove = vi.fn(async () => ({ code: 0, msg: "ok" }));
    const client = {
      im: {
        message: params.tokenExpiry === undefined ? { create, reply, delete: remove } : { create },
      },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
    const newSession = () =>
      createStreamingSession(
        client,
        { appId: params.accountId, appSecret: "test-secret" },
        undefined,
        deps,
      );
    return { session: newSession(), newSession, authTokens, requests, create, reply, remove };
  }

  it.each([
    {
      mode: "create",
      options: undefined,
      method: "create",
      data: expect.not.objectContaining({ root_id: expect.anything() }),
    },
    {
      mode: "root_create",
      options: { rootId: "root_1" },
      method: "create",
      data: expect.objectContaining({ root_id: "root_1" }),
    },
    {
      mode: "reply",
      options: { replyToMessageId: "inbound_1", replyInThread: true, rootId: "root_1" },
      method: "reply",
      data: expect.objectContaining({ reply_in_thread: true }),
    },
  ] as const)(
    "retries, updates and closes an accepted $mode card without its optional message receipt",
    async ({ mode, options, method, data }) => {
      vi.useFakeTimers();
      const { session, requests, create, reply } = mockAcceptedStreamingCard({
        accountId: `accepted-without-receipt-${mode}`,
      });

      const send = method === "reply" ? reply : create;
      send.mockRejectedValueOnce(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      );
      const started = session.start("chat_1", "chat_id", options);
      const accepted = expect(started).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await accepted;
      await session.update("The accepted answer");

      await expect(session.closeWithResult("The accepted answer")).resolves.toEqual({
        visibleReplySent: true,
        content: "The accepted answer",
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          data,
          ...(method === "reply" ? { path: { message_id: "inbound_1" } } : {}),
        }),
      );
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
      expect(method === "reply" ? create : reply).not.toHaveBeenCalled();
      expect(requests.map(({ path }) => path)).toEqual([
        "/open-apis/cardkit/v1/cards/card_accepted/elements/content/content",
        "/open-apis/cardkit/v1/cards/card_accepted/settings",
      ]);
      expect(session.isActive()).toBe(false);
    },
  );

  it.each([undefined, "om_accepted"])(
    "discards an accepted preview with receipt %s",
    async (messageId) => {
      const { session, requests, remove } = mockAcceptedStreamingCard({
        accountId: `discard-${messageId ?? "without-receipt"}`,
        response: { code: 0, msg: "ok", data: { message_id: messageId } },
      });

      await session.start("chat_1");
      await session.update("Transient preview");
      await session.discard();

      if (messageId) {
        expect(remove).toHaveBeenCalledExactlyOnceWith({ path: { message_id: messageId } });
      } else {
        expect(remove).not.toHaveBeenCalled();
        expect(JSON.parse(String(requests[1]?.body.element))).toEqual({
          tag: "markdown",
          content: "",
          element_id: "content",
        });
      }
      expect(requests.map(({ path }) => path)).toEqual([
        "/open-apis/cardkit/v1/cards/card_accepted/elements/content/content",
        ...(!messageId
          ? [
              "/open-apis/cardkit/v1/cards/card_accepted/elements/content",
              "/open-apis/cardkit/v1/cards/card_accepted/settings",
            ]
          : []),
      ]);
      expect(session.isActive()).toBe(false);
    },
  );

  it.each([undefined, "om_accepted"])(
    "retains accepted content and receipt %s when preview removal fails",
    async (messageId) => {
      const { session, remove } = mockAcceptedStreamingCard({
        accountId: `failed-discard-${messageId ?? "without-receipt"}`,
        response: { code: 0, msg: "ok", data: { message_id: messageId } },
        rejectClear: true,
      });
      remove.mockResolvedValue({ code: 230001, msg: "delete rejected" });
      await session.start("chat_1");
      await session.update("Already visible answer");

      await expect(session.discard()).rejects.toMatchObject(
        partialDelivery("Already visible answer", messageId ? { messageIds: [messageId] } : {}),
      );
      expect(remove).toHaveBeenCalledTimes(messageId ? 1 : 0);
      expect(session.isActive()).toBe(false);
    },
  );

  it("preserves accepted visible card content when receipt-free finalization fails", async () => {
    const { session } = mockAcceptedStreamingCard({
      accountId: "failed-close-without-receipt",
      rejectClose: true,
    });

    await session.start("chat_1");
    await session.update("Already visible answer");

    await expect(session.closeWithResult("Already visible answer")).rejects.toMatchObject(
      partialDelivery("Already visible answer"),
    );
  });

  it("still rejects provider-declined streaming card messages", async () => {
    const { session } = mockAcceptedStreamingCard({
      accountId: "declined-streaming-card",
      response: { code: 230099, msg: "message rejected" },
    });

    await expect(session.start("chat_1")).rejects.toThrow("Send card failed: message rejected");
    expect(session.isActive()).toBe(false);
  });

  it.each(["token", "create"])(
    "rejects oversized streaming %s JSON before buffering the full body",
    async (operation) => {
      let clientClosed: Promise<void> | undefined;
      const deps = await createStreamingFetch(({ url, res }) => {
        if (url.pathname.includes("/auth/") && operation === "create") {
          writeJson(res, createStreamingTokenPayload());
        } else if (url.pathname.includes("/auth/") || operation === "create") {
          clientClosed = writeOversizedJson(
            res,
            FEISHU_JSON_MAX_BYTES,
            '{"code":0,"msg":"ok","tenant_access_token":"token","padding":"',
          );
        } else {
          writeJson(res, { code: 0, msg: "ok", data: { card_id: "card_oversized_token" } });
        }
      });
      const session = createStreamingSession(
        (operation === "token"
          ? {}
          : { im: { message: { create: vi.fn() } } }) as unknown as ConstructorParameters<
          typeof FeishuStreamingSession
        >[0],
        { appId: `app_oversized_${operation}`, appSecret: "secret" },
        undefined,
        deps,
      );
      await expect(session.start("chat_id", "open_id")).rejects.toThrow(
        new RegExp(`feishu\\.streaming-card\\.${operation}: JSON response exceeds \\d+ bytes`),
      );
      await expect(clientClosed).resolves.toBeUndefined();
    },
  );

  it("aborts a stalled Feishu tenant-token request after the configured timeout", async () => {
    vi.useFakeTimers();
    let authRequestReceived = false;
    const deps = createMemoryFetch(async (url, _body, init) => {
      if (!url.pathname.includes("/auth/")) {
        return jsonResponse({ code: 0, msg: "ok", data: { card_id: "card_should_not_reach" } });
      }
      authRequestReceived = true;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing guarded fetch signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const reason = signal.reason;
            reject(
              reason instanceof Error ? reason : new Error("request aborted", { cause: reason }),
            );
          },
          { once: true },
        );
      });
    });

    const session = createStreamingSession(
      {} as never,
      {
        appId: "app_stalled_token",
        appSecret: "secret",
        httpTimeoutMs: 25,
      },
      undefined,
      deps,
    );

    const result = expect(session.start("chat_id", "open_id")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toMatch(/timed out/i);
        return true;
      },
    );
    await vi.advanceTimersByTimeAsync(26);
    await result;
    expect(authRequestReceived).toBe(true);
  });

  it.each([
    {
      name: "latest throttled snapshot",
      cardId: "card_1",
      time: 1_000,
      previous: "visible",
      drafts: ["draft one", "draft two"],
      delayed: true,
    },
    {
      name: "natural boundary immediately",
      cardId: "card_2",
      time: 2_000,
      previous: "hello",
      drafts: ["hello!"],
      delayed: false,
    },
  ])("flushes $name", async ({ cardId, time, previous, drafts, delayed }) => {
    vi.useFakeTimers();
    vi.setSystemTime(time);
    const { session, updateBodies } = mockActiveSession({
      cardId,
      text: previous,
      lastUpdateTime: time,
    });
    for (const draft of drafts) {
      await session.update(draft);
    }
    if (delayed) {
      expect(updateBodies).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(160);
    }
    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: drafts.at(-1),
      sequence: 2,
      uuid: `s_${cardId}_2`,
    });
  });

  it("retries the same throttled snapshot after a CardKit body error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_500);
    const bodyErrors: NonNullable<Parameters<typeof mockActiveSession>[1]>["bodyErrors"] = {
      "/elements/content/content": { code: 19_001, msg: "sequence rejected" },
    };
    const { session, updateBodies, log } = mockActiveSession(
      {
        cardId: "card_rejected_flush",
        text: "hello",
        lastUpdateTime: 1_500,
      },
      { bodyErrors },
    );

    await session.update("hello small");
    await vi.advanceTimersByTimeAsync(160);
    delete bodyErrors["/elements/content/content"];
    await session.update("hello small");
    await vi.advanceTimersByTimeAsync(160);

    expect(log).toHaveBeenCalledWith(
      "Update failed: Error: Update card content failed: sequence rejected (code=19001)",
    );
    expect(updateBodies).toHaveLength(2);
    expect(updateBodies.map((body) => JSON.parse(body).content)).toEqual([
      "hello small",
      "hello small",
    ]);
  });

  it("closes with a throttled divergent latest snapshot without merging it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_750);
    const previous = "> Thinking one\n\n---\n\nanswer";
    const next = "> Thinking two\n\n---\n\nanswer more";
    const { session, updateBodies, replaceBodies } = mockActiveSession({
      cardId: "card_pending_reasoning_close",
      text: previous,
      lastUpdateTime: 2_750,
    });

    await session.update(next);
    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(0);

    await session.closeWithResult();

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    const payload = JSON.parse(replaceBodies[0] ?? "{}") as { element?: string };
    expect({ ...payload, element: JSON.parse(payload.element ?? "{}") }).toEqual({
      element: { tag: "markdown", content: next, element_id: "content" },
      sequence: 2,
      uuid: "r_card_pending_reasoning_close_2",
    });
  });

  it("retains prior visible content when CardKit rejects a divergent close replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_900);
    const previous = "> Thinking one\n\n---\n\nanswer";
    const next = "> Thinking two\n\n---\n\nanswer more";
    let sentTextWhenSettingsClosed: string | undefined;
    const { session, replaceBodies, settingsBodies, log } = mockActiveSession(
      { cardId: "card_rejected_pending_reasoning_close", text: previous, lastUpdateTime: 2_900 },
      {
        bodyErrors: { "/elements/content": { code: 19_002, msg: "replacement rejected" } },
        onSettings: (active) => {
          sentTextWhenSettingsClosed = (active as unknown as { state: StreamingSessionState }).state
            .sentText;
        },
      },
    );

    await session.update(next);
    await expect(session.closeWithResult()).rejects.toMatchObject(partialDelivery(previous));

    expect(replaceBodies).toHaveLength(1);
    expect(settingsBodies).toHaveLength(1);
    expect(sentTextWhenSettingsClosed).toBe(previous);
    expect(readSummary(settingsBodies[0])).toBe(previous.replaceAll("\n", " ").trim());
    expect(readSummary(settingsBodies[0])).not.toContain("Thinking two");
    expect(log).toHaveBeenCalledWith(
      "Final replace failed: Error: Replace card content failed: replacement rejected (code=19002)",
    );
  });

  it("logs CardKit body errors for note updates and streaming close settings", async () => {
    const { session, noteBodies, settingsBodies, log } = mockActiveSession(
      {
        cardId: "card_rejected_note_and_close",
        text: "visible answer",
        hasNote: true,
      },
      {
        bodyErrors: {
          "/elements/note/content": { code: 19_003, msg: "note rejected" },
          "/settings": { code: 19_004, msg: "settings rejected" },
        },
      },
    );

    const error = await session
      .closeWithResult(undefined, { note: "model note" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject(
      partialDelivery("visible answer", { messageIds: ["om_rejected_note_and_close"] }),
    );

    expect(noteBodies).toHaveLength(1);
    expect(settingsBodies).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "Note update failed: Error: Update card note failed: note rejected (code=19003)",
    );
    expect(log).toHaveBeenCalledWith(
      "Close failed: Error: Close streaming card failed: settings rejected (code=19004)",
    );
  });

  it.each(["network", "http"])(
    "retries cumulative content after a %s update failure",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(3_000);
      const { session, updateBodies } = mockActiveSession(
        { cardId: `card_${kind}`, text: "hello", lastUpdateTime: 2_000 },
        kind === "network"
          ? { updateIndexes: new Set([0]) }
          : { updateStatuses: new Map([[0, 429]]) },
      );

      await session.update("hello world");
      await session.update("hello world!");

      expect(updateBodies.map((body) => JSON.parse(body))).toEqual([
        { content: "hello world", sequence: 2, uuid: `s_card_${kind}_2` },
        { content: "hello world!", sequence: 3, uuid: `s_card_${kind}_3` },
      ]);
    },
  );

  it("drops a surrogate pair whole when truncating the closeout summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_200);
    // Summary's 47-code-unit cut lands inside this emoji's surrogate pair.
    const finalText = `${"a".repeat(46)}\u{1F600}${"b".repeat(20)}`;
    const settingsBodies: string[] = [];
    const deps = await createStreamingFetch(({ url, body, res }) => {
      if (url.pathname.includes("/auth/")) {
        writeJson(res, createStreamingTokenPayload());
        return;
      }
      if (url.pathname.includes("/settings")) {
        settingsBodies.push(body);
      }
      writeJson(res, { code: 0, msg: "ok" });
    });

    const session = createActiveSession(deps, {
      cardId: "card_surrogate",
      lastUpdateTime: 3_000,
    });

    await session.closeWithResult(finalText);

    expect(settingsBodies).toHaveLength(1);
    const summary = readSummary(settingsBodies[0]);
    expect(summary).toBe(`${"a".repeat(46)}...`);
  });

  it.each([
    { mode: "replace", text: "working\n\nfinal answer", finalText: "final answer" },
    { mode: "update", text: "working", finalText: "working\n\nfinal answer" },
    { mode: "empty", text: "", finalText: "final answer" },
  ])(
    "reports rejected final writes correctly for $mode content",
    async ({ mode, text, finalText }) => {
      vi.useFakeTimers();
      vi.setSystemTime(mode === "replace" ? 4_500 : mode === "update" ? 4_600 : 4_800);
      const replace = mode === "replace";
      const { session, updateBodies, replaceBodies, log } = mockActiveSession(
        {
          cardId: `card_failed_${mode}`,
          text,
          lastUpdateTime: 3_000,
        },
        replace
          ? { replaceStatuses: new Map([[0, 500]]) }
          : { updateStatuses: new Map([[0, 500]]) },
      );
      const error = await session.closeWithResult(finalText).catch((caught: unknown) => caught);
      if (text) {
        expect(error).toMatchObject(
          partialDelivery(
            text,
            replace ? {} : { messageIds: [`om_failed_${mode}`], finalTextAccepted: false },
          ),
        );
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "Update card content failed with HTTP 500" });
        expect(error).not.toHaveProperty("deliveryResult");
      }
      expect(updateBodies).toHaveLength(replace ? 0 : 1);
      expect(replaceBodies).toHaveLength(replace ? 1 : 0);
      expect(log).toHaveBeenCalledWith(
        replace
          ? "Final replace failed: Error: Replace card content failed with HTTP 500"
          : "Final update failed: Error: Update card content failed with HTTP 500",
      );
    },
  );

  it("bounds streaming token cache lifetime when token expiry overflows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    const { authTokens, newSession } = mockAcceptedStreamingCard({
      accountId: "app_unsafe_token_expiry",
      tokenExpiry: Number.MAX_SAFE_INTEGER,
      response: { code: 0, msg: "ok", data: { message_id: "om_1" } },
    });

    await newSession().start("chat_id", "open_id");
    expect(authTokens).toEqual(["token-1"]);

    vi.setSystemTime(Date.now() + 7200 * 1000 - 60_000 + 1);
    await newSession().start("chat_id", "open_id");

    expect(authTokens).toEqual(["token-1", "token-2"]);
  });
});
