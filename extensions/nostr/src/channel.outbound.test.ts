import {
  buildChannelInboundEventContext,
  type dispatchInboundDirectDm as DispatchInboundDirectDm,
} from "openclaw/plugin-sdk/channel-inbound";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nostrPlugin } from "./channel.js";
import { getActiveNostrBuses, nostrOutboundAdapter, startNostrGatewayAccount } from "./gateway.js";
import type { startNostrBus } from "./nostr-bus.js";
import type { NostrIngressLifecycle } from "./nostr-ingress.js";
import { setNostrRuntime } from "./runtime.js";
import {
  NOSTR_SANITIZER_CASES,
  TEST_HEX_PUBLIC_KEY,
  TEST_RESOLVED_PRIVATE_KEY,
  buildResolvedNostrAccount,
  createConfiguredNostrCfg,
  createMockNostrBus,
} from "./test-fixtures.js";

type Bus = ReturnType<typeof createMockNostrBus>;
type BusOptions = Parameters<typeof startNostrBus>[0];
const mocks = vi.hoisted(() => ({
  startNostrBus: vi.fn<(options: BusOptions) => Promise<Bus>>(),
  dispatchInboundDirectDm:
    vi.fn<(params: Parameters<typeof DispatchInboundDirectDm>[0]) => Promise<void>>(),
}));
vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  startNostrBus: mocks.startNostrBus,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  dispatchInboundDirectDm: mocks.dispatchInboundDirectDm,
}));

const eventId = "b".repeat(64);
const convertMarkdownTables = vi.fn((text: string) => text);
const cleanups: Array<() => Promise<void>> = [];
let runtime: ReturnType<typeof createPluginRuntimeMock>;
beforeEach(() => {
  convertMarkdownTables.mockImplementation((text) => text);
  runtime = createPluginRuntimeMock({
    channel: {
      text: { resolveMarkdownTableMode: vi.fn((): "off" => "off"), convertMarkdownTables },
      commands: { shouldComputeCommandAuthorized: vi.fn(() => true) },
      inbound: { buildContext: buildChannelInboundEventContext },
    },
  });
  setNostrRuntime(runtime);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.resetAllMocks();
});

async function startGateway({
  account = buildResolvedNostrAccount(),
  cfg = {},
  bus = createMockNostrBus(eventId),
  abort = new AbortController(),
}: {
  account?: ReturnType<typeof buildResolvedNostrAccount>;
  cfg?: OpenClawConfig;
  bus?: Bus;
  abort?: AbortController;
} = {}) {
  const started = Promise.withResolvers<BusOptions>();
  mocks.startNostrBus.mockImplementationOnce(async (options) => {
    started.resolve(options);
    return bus;
  });
  const statusPatchSink = vi.fn();
  const context = createStartAccountContext({
    account,
    cfg,
    abortSignal: abort.signal,
    statusPatchSink,
  });
  context.channelRuntime = runtime.channel;
  let settled = false;
  const task = startNostrGatewayAccount(context);
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  cleanups.push(async () => {
    abort.abort();
    await task.catch(() => {});
  });
  const options = await started.promise;
  expect(getActiveNostrBuses().get(account.accountId)).toBe(bus);
  return { bus, abort, task, options, context, statusPatchSink, isSettled: () => settled };
}

const send = (text: string) =>
  nostrOutboundAdapter.sendText({
    cfg: {},
    to: TEST_HEX_PUBLIC_KEY,
    text,
    accountId: "default",
  });

describe("nostr gateway lifecycle", () => {
  it.each([false, true])("retires the bus before shutdown settles (failure=%s)", async (fails) => {
    const close = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const bus = createMockNostrBus(eventId);
    bus.close.mockImplementationOnce(() => {
      closing.resolve();
      return close.promise;
    });
    const h = await startGateway({ bus });
    try {
      expect(h.isSettled()).toBe(false);
      h.abort.abort();
      await closing.promise;
      expect(h.isSettled()).toBe(false);
      expect(getActiveNostrBuses().has("default")).toBe(false);
      await expect(send("hello")).rejects.toThrow("Nostr bus not running for account default");
      expect(bus.sendDm).not.toHaveBeenCalled();
      expect(h.context.log?.info).not.toHaveBeenCalledWith("[default] Nostr provider stopped");
      if (fails) {
        const error = new Error("Nostr relay shutdown failed");
        close.reject(error);
        await expect(h.task).rejects.toBe(error);
        expect(h.context.log?.info).not.toHaveBeenCalledWith("[default] Nostr provider stopped");
      } else {
        close.resolve();
        await expect(h.task).resolves.toBeUndefined();
        expect(h.context.log?.info).toHaveBeenCalledWith("[default] Nostr provider stopped");
      }
      expect(bus.close).toHaveBeenCalledOnce();
      expect(getActiveNostrBuses().has("default")).toBe(false);
    } finally {
      close.resolve();
    }
  });

  it("preserves a replacement bus while the previous generation closes", async () => {
    const close = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const bus = createMockNostrBus(eventId);
    bus.close.mockImplementationOnce(() => {
      closing.resolve();
      return close.promise;
    });
    const first = await startGateway({ bus });
    try {
      const replacement = await startGateway();
      first.abort.abort();
      await closing.promise;
      expect(getActiveNostrBuses().get("default")).toBe(replacement.bus);
      close.resolve();
      await first.task;
      expect(getActiveNostrBuses().get("default")).toBe(replacement.bus);
      replacement.abort.abort();
      await replacement.task;
      expect(getActiveNostrBuses().has("default")).toBe(false);
    } finally {
      close.resolve();
    }
  });

  it("closes immediately for an already-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    const h = await startGateway({ abort });
    await h.task;
    expect(mocks.startNostrBus).toHaveBeenCalledOnce();
    expect(h.bus.close).toHaveBeenCalledOnce();
  });

  it("becomes ready on connection and recovers only after the last relay disconnects", async () => {
    const h = await startGateway();
    expect(h.context.getStatus()).toMatchObject({ lifecycle: "starting" });
    expect(h.context.log?.info).toHaveBeenCalledWith(
      "[default] Nostr provider started with 1 configured relay(s)",
    );
    h.options.onConnect?.("wss://relay-one.example/");
    expect(h.context.getStatus()).toMatchObject({
      running: true,
      lifecycle: "ready",
      connected: true,
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    h.options.onConnect?.("wss://relay-two.example/");
    const connectedUpdates = h.statusPatchSink.mock.calls.length;
    h.options.onDisconnect?.("wss://relay-one.example");
    expect(h.statusPatchSink).toHaveBeenCalledTimes(connectedUpdates);
    h.options.onDisconnect?.("wss://relay-two.example");
    expect(h.context.getStatus()).toMatchObject({ lifecycle: "recovering", connected: false });
  });
});

describe("nostr inbound", () => {
  it("challenges unknown senders before decrypting their DM", async () => {
    const h = await startGateway({
      account: buildResolvedNostrAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
    });
    const reply = vi.fn(async (_text: string) => {});
    await expect(
      h.options.authorizeSender?.({ senderPubkey: TEST_HEX_PUBLIC_KEY, reply }),
    ).resolves.toBe("pairing");
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Pairing code:"));
    expect(mocks.dispatchInboundDirectDm).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "redacts traces before rendering Markdown",
      text: '<tool_call>{"name":"read","arguments":{"path":"private"}}</tool_call>**Table:** [docs](https://example.com)',
      visible: "**Table:** [docs](https://example.com)",
      expected: "Table: docs (https://example.com)",
    },
    {
      name: "suppresses trace-only replies",
      text: "\u26a0\ufe0f \u{1f6e0}\ufe0f `search repos (agent)` failed",
      visible: "",
      expected: "",
    },
    { name: "suppresses Markdown-only replies", text: "***", visible: "***", expected: "" },
  ])("$name through the reply pipeline", async ({ text, visible, expected }) => {
    mocks.dispatchInboundDirectDm.mockImplementationOnce(async (params) => {
      await params.deliver({ text });
    });
    const h = await startGateway({
      account: buildResolvedNostrAccount({
        config: { dmPolicy: "allowlist", allowFrom: [`nostr:${TEST_HEX_PUBLIC_KEY}`] },
      }),
    });
    const reply = vi.fn(async (_text: string) => {});
    const lifecycle: NostrIngressLifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };
    await h.options.onMessage(
      TEST_HEX_PUBLIC_KEY,
      "hello from nostr",
      reply,
      { eventId: "event-123", createdAt: 1_710_000_000 },
      lifecycle,
    );
    expect(mocks.dispatchInboundDirectDm).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "nostr",
        accountId: "default",
        peer: { kind: "direct", id: TEST_HEX_PUBLIC_KEY },
        senderId: TEST_HEX_PUBLIC_KEY,
        rawBody: "hello from nostr",
        messageId: "event-123",
        timestamp: 1_710_000_000_000,
        commandAuthorized: true,
        turnAdoptionLifecycle: expect.objectContaining({ admission: "exclusive" }),
        channelRuntime: runtime.channel,
      }),
    );
    if (visible) {
      expect(convertMarkdownTables).toHaveBeenCalledWith(visible, "off");
    } else {
      expect(convertMarkdownTables).not.toHaveBeenCalled();
    }
    if (expected) {
      expect(reply).toHaveBeenCalledWith(expected);
    } else {
      expect(reply).not.toHaveBeenCalled();
    }
  });
});

describe("nostr outbound", () => {
  it.each(NOSTR_SANITIZER_CASES)("$name", ({ text, expected }) => {
    expect(nostrPlugin.outbound?.sanitizeText?.({ text, payload: { text } })).toBe(expected);
  });

  it("chunks oversized encrypted replies without splitting Unicode", () => {
    const text = `a${"😀".repeat(2_500)}`;
    expect(nostrPlugin.outbound?.textChunkLimit).toBe(4_000);
    const chunks = nostrPlugin.outbound?.chunker?.(text, 4_000);
    expect(chunks).toHaveLength(2);
    expect(chunks?.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks?.join("")).toBe(text);
  });

  it("sends converted tables through the configured default account and returns its relay receipt", async () => {
    convertMarkdownTables.mockReturnValueOnce("**Table:** [docs](https://example.com)");
    const cfg = createConfiguredNostrCfg({
      defaultAccount: "work",
      privateKey: TEST_RESOLVED_PRIVATE_KEY,
    });
    const h = await startGateway({
      account: buildResolvedNostrAccount({ accountId: "work" }),
      cfg,
    });
    const result = await nostrOutboundAdapter.sendText({
      cfg,
      to: TEST_HEX_PUBLIC_KEY.toUpperCase(),
      text: "|a|b|",
    });
    expect(runtime.channel.text.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nostr",
      accountId: "work",
    });
    expect(convertMarkdownTables).toHaveBeenCalledWith("|a|b|", "off");
    expect(h.bus.sendDm).toHaveBeenCalledWith(
      TEST_HEX_PUBLIC_KEY,
      "Table: docs (https://example.com)",
      expect.any(Object),
    );
    expect(result.messageId).toBe(eventId);
  });

  it("rejects empty text after Markdown conversion", async () => {
    const h = await startGateway();
    await expect(send("***")).rejects.toThrow("requires non-empty text");
    expect(h.bus.sendDm).not.toHaveBeenCalled();
  });

  it("backs declared message capabilities with a delivered text receipt", async () => {
    const h = await startGateway();
    const adapter = nostrPlugin.message;
    if (!adapter?.send?.text) {
      throw new Error("Expected Nostr message adapter");
    }
    const sendText = adapter.send.text;
    expect(adapter.send.media).toBeUndefined();
    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "nostrMessageAdapter",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: {},
            to: TEST_HEX_PUBLIC_KEY,
            text: "hello",
            accountId: "default",
          });
          expect(h.bus.sendDm).toHaveBeenCalledWith(
            TEST_HEX_PUBLIC_KEY,
            "hello",
            expect.any(Object),
          );
          expect(result.receipt.parts[0]?.kind).toBe("text");
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });
});
