// Line tests cover durable unknown-send reconciliation behavior.
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { linePlugin } from "./channel.js";
import { recordLineDurableSendPlan } from "./durable-send-plan.js";
import {
  createLineBlobStoreState,
  type LineBlobStoreFake,
} from "./outbound-harness.test-support.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";
import { LINE_RETRY_KEY_TTL_MS, resolveLinePushRetryKey } from "./send-retry.js";

const NOW = 1_800_000_000_000;
const QUEUE_ID = "queue-entry-1";
const TARGET = "line:user:U0123456789abcdef0123456789abcdef";
const CFG = {
  channels: { line: { channelAccessToken: "test-token-placeholder" } },
} as OpenClawConfig;

let blobs: LineBlobStoreFake;
const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Drives the real push path so the recorded plan is written by production code
 * rather than by a stand-in that could forget to record anything.
 */
async function sendDurablePart(params: { partIndex: number; partCount: number; text: string }) {
  await linePlugin.outbound?.sendPayload?.({
    cfg: CFG,
    to: TARGET,
    text: params.text,
    payload: { text: params.text },
    deliveryQueueId: QUEUE_ID,
    deliveryPartIndex: params.partIndex,
    deliveryPartCount: params.partCount,
  });
}

/** A flex payload fans one part out into two pushes: the card, then the text. */
async function sendDurableFlexPart() {
  await linePlugin.outbound?.sendPayload?.({
    cfg: CFG,
    to: TARGET,
    text: "hello",
    payload: {
      text: "hello",
      channelData: { line: { flexMessage: { altText: "alt", contents: { type: "bubble" } } } },
    },
    deliveryQueueId: QUEUE_ID,
    deliveryPartIndex: 0,
    deliveryPartCount: 1,
  });
}

function pushedRequests(): { retryKey: string | null; messages: unknown }[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body = typeof init?.body === "string" ? init.body : "{}";
    return {
      retryKey: new Headers(init?.headers).get("X-Line-Retry-Key"),
      messages: (JSON.parse(body) as { messages?: unknown }).messages,
    };
  });
}

function planKeys(): string[] {
  return Array.from(blobs.keys()).toSorted();
}

/** Stored plan shape the tests reshape to stand in for an interrupted run. */
type StoredPlan = Record<string, unknown> & {
  pushes: { retryKey: string; messages: unknown[] }[];
};

function readPlan(key: string): StoredPlan {
  return JSON.parse(new TextDecoder().decode(blobs.get(key)!)) as StoredPlan;
}

function reconcile(overrides: Partial<ChannelMessageUnknownSendContext> = {}) {
  const ctx: ChannelMessageUnknownSendContext = {
    cfg: CFG,
    queueId: QUEUE_ID,
    channel: "line",
    to: TARGET,
    enqueuedAt: NOW,
    platformSendStartedAt: NOW,
    retryCount: 1,
    payloads: [{ text: "hello" }],
    ...overrides,
  };
  return linePlugin.message?.durableFinal?.reconcileUnknownSend?.(ctx);
}

describe("LINE unknown-send reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock.mockReset();
    // A Response body can only be read once, so every call builds a fresh one.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = createLineBlobStoreState();
    blobs = store.blobs;
    // The real send path owns the recording, so the runtime keeps only the
    // chunker and the durable store the production code reaches for.
    setLineRuntime({
      state: store.state,
      channel: {
        text: {
          chunkMarkdownText: (text: string) => [text],
          resolveTextChunkLimit: () => 5000,
        },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reissues every recorded push under the key LINE deduplicated it by", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    await sendDurablePart({ partIndex: 1, partCount: 2, text: "second" });
    const live = pushedRequests();
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });

    // The replay reissues the live requests verbatim: same order, same keys,
    // same bodies. That is what makes LINE answer 409 instead of delivering again.
    expect(pushedRequests()).toEqual(live);
    expect(live.map((request) => request.retryKey)).toEqual([
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 }),
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 1, pushIndex: 0 }),
    ]);
    expect(live.map((request) => request.messages)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
  });

  it("returns the identity of every replayed push, not just the last of each part", async () => {
    await sendDurableFlexPart();
    fetchMock.mockClear();
    let replayed = 0;
    fetchMock.mockImplementation(async () => {
      replayed += 1;
      return jsonResponse({ sentMessages: [{ id: `replayed-${replayed}` }] });
    });

    const reconciliation = await reconcile();

    // Both physical sends of the fan-out settle the queue entry; dropping one
    // would lose delivery identity for part of a recovered reply.
    expect(replayed).toBe(2);
    expect(reconciliation).toMatchObject({ status: "sent" });
    expect(
      (reconciliation as { receipt: { platformMessageIds: string[] } }).receipt.platformMessageIds,
    ).toEqual(["replayed-1", "replayed-2"]);
  });

  it("marks the platform dispatch once, before the first push of a fanned-out part", async () => {
    const events: string[] = [];
    const onPlatformSendDispatch = vi.fn(async () => {
      events.push("dispatch");
    });
    fetchMock.mockImplementation(async () => {
      events.push("push");
      return jsonResponse({ sentMessages: [{ id: "delivered-1" }] });
    });

    await linePlugin.outbound?.sendPayload?.({
      cfg: CFG,
      to: TARGET,
      text: "hello",
      payload: {
        text: "hello",
        channelData: { line: { flexMessage: { altText: "alt", contents: { type: "bubble" } } } },
      },
      deliveryQueueId: QUEUE_ID,
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      onPlatformSendDispatch,
    });

    // The marker is what makes the queue entry recoverable: a crash after it is
    // reconciled against LINE, while a crash before it looks like a send that never
    // started. It has to precede the first request, and a part that fans out into
    // several pushes is still one payload crossing the boundary, so it fires once.
    expect(events).toEqual(["dispatch", "push", "push"]);
  });
  it.each([
    [
      "a card, media and text",
      {
        text: "caption",
        mediaUrl: "https://example.com/image.png",
        channelData: { line: { flexMessage: { altText: "alt", contents: { type: "bubble" } } } },
      },
    ],
    [
      "a batch carrying quick replies",
      {
        text: "",
        channelData: {
          line: {
            quickReplies: ["One", "Two"],
            flexMessage: { altText: "alt", contents: { type: "bubble" } },
          },
        },
      },
    ],
    [
      "markdown that renders as its own segments",
      { text: "| Name | Status |\n|---|---|\n| OpenClaw | ready |\n\nAfter the table." },
    ],
  ])("keys every platform send %s fans out into", async (_name, payload) => {
    await linePlugin.outbound?.sendPayload?.({
      cfg: CFG,
      to: TARGET,
      text: (payload as { text: string }).text,
      payload,
      deliveryQueueId: QUEUE_ID,
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
    });

    // A media or card push is replayed under the same key a text push is, and the
    // adapter declares it reconciles those kinds; a push that skipped the recorder
    // would be replayed under a fresh key LINE cannot deduplicate.
    const keys = pushedRequests().map((request) => request.retryKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(
      keys.map((_, pushIndex) =>
        resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex }),
      ),
    );
  });

  it("refuses a delivery that carried no durable record instead of replaying it", async () => {
    // A recorded push lands before the marker that routes a delivery here, so an
    // empty record means core withheld the queue id and those pushes went out
    // under keys LINE will not deduplicate. Replaying is a second copy.
    await expect(reconcile()).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records the pushes a crash never reached, so the replay can deliver them", async () => {
    // The whole fan-out is written before any of it leaves, so a crash partway
    // through does not truncate the record. Standing in for that crash: the second
    // push never reaches LINE.
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("process died before the second push");
    });
    await expect(sendDurableFlexPart()).rejects.toThrow();
    const [key] = planKeys();
    expect(readPlan(key!).pushes).toHaveLength(2);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );

    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });

    // The accepted push is reissued under its key so LINE drops it as a duplicate,
    // and the one the crash cut off is delivered for the first time.
    expect(pushedRequests().map((request) => request.retryKey)).toEqual([
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 }),
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 1 }),
    ]);
  });

  it("keeps the whole recorded fan-out after a replay that is itself interrupted", async () => {
    // Two pushes in one part: the flex card, then the text.
    await sendDurableFlexPart();
    const [key] = planKeys();
    expect(readPlan(key!).pushes).toHaveLength(2);

    // A replay that dies on its very first reissued push must not leave the
    // record shorter than it found it: the pushes it never reached would then
    // have nothing left to be compared against on the next recovery.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => {
      throw new Error("recovery process died mid-replay");
    });
    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved" });

    expect(readPlan(key!).pushes).toHaveLength(2);
  });

  it("replays what was recorded when the same delivery now renders differently", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    const recorded = pushedRequests();
    fetchMock.mockClear();

    // A retry of the same queued send re-renders from live configuration, which an
    // upgrade or a chunk-limit change can make differ. The keys are derived from the
    // delivery, so reissuing the new render under them would let LINE answer 409 for
    // a request it never saw and drop the difference. The record wins instead.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "something else entirely" });

    expect(pushedRequests()).toEqual(recorded);
    const [key] = planKeys();
    expect(readPlan(key!).pushes).toEqual(
      recorded.map((request) => ({ retryKey: request.retryKey, messages: request.messages })),
    );
  });

  it("records the quote with the request, so a replay still quotes the answered message", async () => {
    // Quote tokens live only in this process's memory, so after a restart the
    // replay can quote the answered message only if the recorded request carries it.
    recordLineQuoteToken({
      accountId: "default",
      chatId: TARGET,
      messageId: "inbound-1",
      quoteToken: "q-inbound-1",
    });
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("process died before LINE answered");
    });
    await expect(
      linePlugin.outbound?.sendPayload?.({
        cfg: CFG,
        to: TARGET,
        text: "answering you",
        payload: { text: "answering you" },
        replyToId: "inbound-1",
        deliveryQueueId: QUEUE_ID,
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    ).rejects.toThrow();
    const quoted = [{ type: "text", text: "answering you", quoteToken: "q-inbound-1" }];
    const [key] = planKeys();
    expect(readPlan(key!).pushes.map((push) => push.messages)).toEqual([quoted]);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );
    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });

    expect(pushedRequests().map((request) => request.messages)).toEqual([quoted]);
  });

  it("re-records a part whose previous plan has expired", async () => {
    // The store counts an expired row as occupied — it does not filter the deadline —
    // so the sweep before the claim is what lets the same delivery be recorded again
    // once LINE has forgotten its keys. Without it every later attempt is refused.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    expect(planKeys()).toHaveLength(1);
    fetchMock.mockClear();

    vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS + 2 * 60 * 60 * 1000);

    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello again" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pushedRequests()[0]?.messages).toEqual([{ type: "text", text: "hello again" }]);
  });

  it("refuses a claim whose stored plan describes a different fan-out", async () => {
    // A retry re-renders from live configuration. If it now plans a different number of
    // parts, the stored plan is not this send's plan: replaying it would mix old and new
    // parts in one delivery and wedge reconciliation on an inconsistent topology.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();

    await expect(sendDurablePart({ partIndex: 0, partCount: 2, text: "hello" })).rejects.toThrow(
      "was recorded for a different fan-out",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a claim whose stored plan names a different recipient", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();

    await expect(
      linePlugin.outbound?.sendPayload?.({
        cfg: CFG,
        to: "line:user:Ufedcba9876543210fedcba9876543210",
        text: "hello",
        payload: { text: "hello" },
        deliveryQueueId: QUEUE_ID,
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      } as never),
    ).rejects.toThrow("was recorded for a different recipient");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a claim whose stored plan names a different account", async () => {
    // LINE remembers a retry key per channel, so a record claimed under one account
    // says nothing about whether another account's channel accepted the same key.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();

    await expect(
      linePlugin.outbound?.sendPayload?.({
        cfg: CFG,
        to: TARGET,
        text: "hello",
        payload: { text: "hello" },
        accountId: "second",
        deliveryQueueId: QUEUE_ID,
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      } as never),
    ).rejects.toThrow("was recorded for a different account");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a payload core planned no parts for as the single part it is", async () => {
    // Core sets part coordinates in its text and media planners only; a structured
    // payload — the `ask_user` prompt, an exec-approval prompt — arrives with none.
    // Refusing it here would fail those prompts outright on a required durable send.
    await linePlugin.outbound?.sendPayload?.({
      cfg: CFG,
      to: TARGET,
      text: "pick one",
      payload: { text: "pick one" },
      deliveryQueueId: QUEUE_ID,
    } as never);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [key] = planKeys();
    expect(readPlan(key!)).toMatchObject({ partIndex: 0, partCount: 1 });
    expect(pushedRequests()[0]?.retryKey).toBe(
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 }),
    );
  });

  it.each([
    [{ partIndex: undefined, partCount: 1 }, "part index must be a non-negative integer"],
    [{ partIndex: 0, partCount: undefined }, "cannot be recorded"],
  ])("refuses to record a part whose topology its caller lost", async (topology, message) => {
    // The default above belongs to the payload route, which knows it is one part of
    // one. Any other route reaching the recorder without coordinates has lost them,
    // and substituting a value there would record a topology the delivery never had.
    await expect(
      recordLineDurableSendPlan({
        queueId: QUEUE_ID,
        to: TARGET,
        pushes: [{ retryKey: "k", messages: [{ type: "text", text: "hello" }] }],
        ...topology,
      }),
    ).rejects.toThrow(message);
    expect(planKeys()).toHaveLength(0);
  });

  it("refuses to replay when a planned part was never dispatched", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The plan is written just before the dispatch marker the window is measured
  // from, so a plan expiring on the bare retry-key TTL is already gone for the
  // last stretch of the window it exists to serve. Reconciliation reads a missing
  // plan as "this delivery carried no recorder" and retires a reply LINE would
  // still have deduplicated.
  // The queue entry's timestamp is refreshed on every dispatch, so it cannot say when
  // LINE first saw these keys. The plan records that instant, and it is what decides
  // the window: a delivery whose keys are a day old must be refused even though the
  // entry says the latest attempt started seconds ago.
  it("measures the window from the recorded dispatch, not the refreshed queue entry", async () => {
    await sendDurableFlexPart();
    fetchMock.mockClear();
    vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS + 1);

    const result = await reconcile({ platformSendStartedAt: NOW + LINE_RETRY_KEY_TTL_MS });

    expect(result).toEqual({
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Entering the window is not enough: the retry backoff between attempts can outlast
  // it. Once LINE has stopped deduplicating the key, another attempt is a second
  // delivery, so the replay has to stop mid-backoff rather than finish its retries.
  it("stops a replay whose backoff outlives the retry-key window", async () => {
    vi.useFakeTimers();
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();
    // The first attempt fails retryably and moves the clock past the deadline, so the
    // runner backs off into a window LINE no longer deduplicates.
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS);
      return jsonResponse({ message: "upstream" }, 503);
    });

    const reconciling = reconcile({ platformSendStartedAt: NOW });
    await vi.runAllTimersAsync();
    const result = await reconciling;

    expect(result).toMatchObject({ status: "unresolved", retryable: false });
    // Exactly the one attempt that was still inside the window.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  /** Installs a plan store and a logger whose warnings the test can read. */
  function usePlanStore(
    openBlobStore: (options: { namespace: string }) => unknown,
    chunkMarkdownText: (text: string) => string[] = (text) => [text],
    chunkLimit = 5000,
  ) {
    const warn = vi.fn<(message: string) => void>();
    setLineRuntime({
      state: { openBlobStore },
      logging: { getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }) },
      channel: { text: { chunkMarkdownText, resolveTextChunkLimit: () => chunkLimit } },
    } as unknown as PluginRuntime);
    return warn;
  }

  /**
   * One row, taken by the first recorded part: the store refuses a zero ceiling when it
   * is opened, so a full namespace has to be reached rather than declared.
   */
  function useOneRowPlanStore() {
    const store = createLineBlobStoreState();
    const warn = usePlanStore((options) =>
      store.state.openBlobStore({ ...options, maxEntries: 1, overflowPolicy: "reject-new" }),
    );
    return { store, warn };
  }

  // The plan is crash evidence, not the delivery: a store that will not take it costs
  // the send its recovery, never its reply, and the operator is told which one.
  it("sends a part the plan store refuses, under its derived key and without a record", async () => {
    const { store, warn } = useOneRowPlanStore();
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "the one row this holds" });
    fetchMock.mockClear();

    await linePlugin.outbound?.sendPayload?.({
      cfg: CFG,
      to: TARGET,
      text: "hello",
      payload: { text: "hello" },
      deliveryQueueId: "queue-entry-2",
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
    });

    expect(pushedRequests().map((request) => request.retryKey)).toEqual([
      resolveLinePushRetryKey({ deliveryQueueId: "queue-entry-2", partIndex: 0, pushIndex: 0 }),
    ]);
    expect(store.blobs.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Plugin blob namespace reached its stored row limit."),
    );

    // What it lost is recovery: a restart finds no record and refuses to replay it.
    fetchMock.mockClear();
    await expect(reconcile({ queueId: "queue-entry-2" })).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends a later part the plan store refuses, so the reply is not cut short", async () => {
    const { store, warn } = useOneRowPlanStore();

    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    await sendDurablePart({ partIndex: 1, partCount: 2, text: "second" });

    expect(pushedRequests().map((request) => request.retryKey)).toEqual([
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 }),
      resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 1, pushIndex: 0 }),
    ]);
    expect(store.blobs.size).toBe(1);
    expect(warn).toHaveBeenCalledOnce();

    // A crash before it settles still ends unresolved rather than replaying half of it.
    fetchMock.mockClear();
    await expect(reconcile()).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
      error: expect.stringContaining("missing recorded parts: 1"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Both byte ceilings reach an operator under the store's own message, which is what
  // the troubleshooting docs name.
  it.each([
    { name: "per-entry", option: "maxBytesPerEntry", message: "byte limit" },
    {
      name: "namespace",
      option: "maxBytesPerNamespace",
      message: "Plugin blob namespace reached its stored byte limit.",
    },
  ])("still sends a part whose record hits the $name ceiling", async ({ option, message }) => {
    const store = createLineBlobStoreState();
    // Held in a box because the opener closes over it before the measuring run has
    // produced the value the restricted run needs.
    const limit: { bytes?: number } = {};
    const writes: number[] = [];
    const warn = usePlanStore(
      (options) => {
        const opened = store.state.openBlobStore({ ...options, [option]: limit.bytes });
        return {
          ...opened,
          registerIfAbsent: async (key: string, bytes: Uint8Array, ...rest: unknown[]) => {
            writes.push(bytes.byteLength);
            return await (opened.registerIfAbsent as (...args: unknown[]) => Promise<boolean>)(
              key,
              bytes,
              ...rest,
            );
          },
        };
      },
      (text) => text.match(/.{1,40}/gs) ?? [text],
      40,
    );
    const threeChunks = "x".repeat(120);

    // Measure the one write this part makes, then cap just under it.
    await sendDurablePart({ partIndex: 0, partCount: 1, text: threeChunks });
    expect(writes).toHaveLength(1);
    limit.bytes = writes[0]! - 1;
    store.blobs.clear();
    fetchMock.mockClear();

    await sendDurablePart({ partIndex: 0, partCount: 1, text: threeChunks });

    // The part went out whole, under the keys its record would have carried.
    const sent = pushedRequests();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((request) => request.retryKey)).toEqual(
      sent.map((_, pushIndex) =>
        resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex }),
      ),
    );
    expect(store.blobs.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it("reissues a recorded request exactly as stored, without normalizing it again", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    const [key] = planKeys();
    // A record written by a build whose normalization differed, standing in for an
    // upgrade between the send and its replay: today's cap would cut this label to 20.
    const stored = readPlan(key!);
    const recorded = {
      type: "text",
      text: "hello",
      quickReply: {
        items: [
          {
            type: "action",
            action: { type: "message", label: "a label past today's cap", text: "ok" },
          },
        ],
      },
    };
    stored.pushes[0]!.messages = [recorded];
    blobs.set(key!, new TextEncoder().encode(JSON.stringify(stored)));
    fetchMock.mockClear();

    await expect(reconcile()).resolves.toMatchObject({ status: "sent" });
    expect(pushedRequests()).toEqual([
      { retryKey: stored.pushes[0]!.retryKey, messages: [recorded] },
    ]);
  });

  // The store checks the entry size before it looks for the key, so a retry whose new
  // render is too large is refused while its record is still there. Sending the new render
  // would put different content behind keys that record already claims.
  it("replays the stored record when the store refuses a retry's new write", async () => {
    const store = createLineBlobStoreState();
    const limit: { bytes?: number } = {};
    const warn = usePlanStore((options) =>
      store.state.openBlobStore({ ...options, maxBytesPerEntry: limit.bytes }),
    );
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    const recorded = pushedRequests();
    fetchMock.mockClear();
    limit.bytes = Array.from(store.blobs.values())[0]!.byteLength;

    await sendDurablePart({ partIndex: 0, partCount: 1, text: `hello ${"x".repeat(200)}` });

    expect(pushedRequests()).toEqual(recorded);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends nothing when the store refuses the write and cannot be read", async () => {
    const store = createLineBlobStoreState();
    const warn = usePlanStore((options) => ({
      ...store.state.openBlobStore(options),
      registerIfAbsent: async () => {
        throw new Error("state directory refused the write");
      },
      lookup: async () => {
        throw new Error("state directory refused the read");
      },
    }));

    await expect(sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" })).rejects.toThrow(
      "state directory refused the read",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses to replay once LINE has forgotten the retry keys", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockClear();

    await expect(
      reconcile({ platformSendStartedAt: NOW - LINE_RETRY_KEY_TTL_MS }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    });
    // Replaying an expired key would deliver a second copy, so nothing is sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a deterministic rejection of the first push as never sent", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockImplementation(async () => jsonResponse({ message: "invalid recipient" }, 400));

    await expect(reconcile()).resolves.toEqual({ status: "not_sent" });
  });

  it("keeps a replay refused for its credentials unresolved instead of claiming nothing landed", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    // A 401 refuses today's token, not the request, so it cannot show that LINE turned
    // down the interrupted attempt that went out under the same key.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ message: "Authentication failed" }, 401),
    );

    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved" });
  });

  it("stops before the unquoted retry once the retry-key window has closed", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: TARGET,
      messageId: "inbound-2",
      quoteToken: "q-inbound-2",
    });
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("process died before LINE answered");
    });
    await expect(
      linePlugin.outbound?.sendPayload?.({
        cfg: CFG,
        to: TARGET,
        text: "late",
        payload: { text: "late" },
        replyToId: "inbound-2",
        deliveryQueueId: QUEUE_ID,
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    ).rejects.toThrow();
    fetchMock.mockClear();
    // LINE refuses the quoted replay just as the window closes; the unquoted retry that
    // would follow must not go out under a key LINE no longer deduplicates.
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(NOW + LINE_RETRY_KEY_TTL_MS);
      return jsonResponse({ message: "Invalid quote token" }, 400);
    });

    await expect(reconcile()).resolves.toEqual({
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a rejection after an accepted push unresolved instead of claiming nothing landed", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 2, text: "first" });
    await sendDurablePart({ partIndex: 1, partCount: 2, text: "second" });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sentMessages: [{ id: "delivered-1" }] }))
      .mockImplementation(async () => jsonResponse({ message: "invalid recipient" }, 400));

    // The first part is delivered, so "never sent" would license a full replay.
    await expect(reconcile()).resolves.toMatchObject({ status: "unresolved", retryable: false });
  });

  it("leaves a transient failure unresolved and retryable", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    fetchMock.mockImplementation(async () => jsonResponse({ message: "boom" }, 500));

    const reconciled = reconcile();
    await vi.runAllTimersAsync();

    await expect(reconciled).resolves.toMatchObject({ status: "unresolved", retryable: true });
  });

  it("drops recorded content once the delivery is settled", async () => {
    await sendDurablePart({ partIndex: 0, partCount: 1, text: "hello" });
    expect(planKeys()).toHaveLength(1);

    await linePlugin.message?.durableFinal?.afterUnknownSendTerminal?.({
      cfg: CFG,
      queueId: QUEUE_ID,
      channel: "line",
      to: TARGET,
      enqueuedAt: NOW,
      retryCount: 1,
      payloads: [{ text: "hello" }],
    });

    expect(planKeys()).toHaveLength(0);
  });
});

describe("durable retry keys", () => {
  it("derives the same key for one durable push in every process", () => {
    const key = resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 });

    expect(resolveLinePushRetryKey({ deliveryQueueId: QUEUE_ID, partIndex: 0, pushIndex: 0 })).toBe(
      key,
    );
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("keys each part and each push inside a part separately", () => {
    const first = resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 0, pushIndex: 0 });

    expect(resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 1, pushIndex: 0 })).not.toBe(
      first,
    );
    expect(resolveLinePushRetryKey({ deliveryQueueId: "q", partIndex: 0, pushIndex: 1 })).not.toBe(
      first,
    );
  });

  it("keeps unqueued sends on fresh keys", () => {
    expect(resolveLinePushRetryKey({})).not.toBe(resolveLinePushRetryKey({}));
  });
});
