import {
  buildChannelInboundEventContext,
  type dispatchInboundDirectDm as DispatchInboundDirectDm,
} from "openclaw/plugin-sdk/channel-inbound";
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
}: {
  account?: ReturnType<typeof buildResolvedNostrAccount>;
  cfg?: OpenClawConfig;
  bus?: Bus;
} = {}) {
  const abort = new AbortController();
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
  const task = startNostrGatewayAccount(context);
  const settled = vi.fn();
  void task.then(settled, settled);
  cleanups.push(async () => {
    abort.abort();
    await task.catch(() => {});
  });
  const options = await started.promise;
  expect(getActiveNostrBuses().get(account.accountId)).toBe(bus);
  return { bus, abort, task, options, context, statusPatchSink, settled };
}

const send = (text: string) =>
  nostrOutboundAdapter.sendText({ cfg: {}, to: TEST_HEX_PUBLIC_KEY, text, accountId: "default" });

async function startClosingGateway() {
  const close = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const bus = createMockNostrBus(eventId);
  bus.close.mockImplementationOnce(() => {
    closing.resolve();
    return close.promise;
  });
  const gateway = await startGateway({ bus });
  // Release shutdown before startGateway's cleanup waits for the task.
  cleanups.push(async () => close.resolve());
  return { ...gateway, close, closing };
}

describe("nostr gateway lifecycle", () => {
  it.each([false, true])("retires the bus before shutdown settles (failure=%s)", async (fails) => {
    const h = await startClosingGateway();
    expect(h.settled).not.toHaveBeenCalled();
    h.abort.abort();
    await h.closing.promise;
    expect(h.settled).not.toHaveBeenCalled();
    expect(getActiveNostrBuses().has("default")).toBe(false);
    await expect(send("hello")).rejects.toThrow("Nostr bus not running for account default");
    await expect(
      nostrPlugin.pairing!.notifyApproval!({ cfg: {}, id: TEST_HEX_PUBLIC_KEY }),
    ).rejects.toThrow("Nostr bus not running for account default");
    expect(h.bus.sendDm).not.toHaveBeenCalled();
    if (fails) {
      const error = new Error("Nostr relay shutdown failed");
      h.close.reject(error);
      await expect(h.task).rejects.toBe(error);
    } else {
      h.close.resolve();
      await expect(h.task).resolves.toBeUndefined();
    }
    expect(h.bus.close).toHaveBeenCalledOnce();
    expect(getActiveNostrBuses().has("default")).toBe(false);
  });

  it("preserves a replacement bus while the previous generation closes", async () => {
    const first = await startClosingGateway();
    const replacement = await startGateway();
    first.abort.abort();
    await first.closing.promise;
    expect(getActiveNostrBuses().get("default")).toBe(replacement.bus);
    first.close.resolve();
    await first.task;
    expect(getActiveNostrBuses().get("default")).toBe(replacement.bus);
    replacement.abort.abort();
    await replacement.task;
    expect(getActiveNostrBuses().has("default")).toBe(false);
  });

  it("becomes ready on connection and recovers only after the last relay disconnects", async () => {
    const profile = { name: "Synthetic profile" };
    const h = await startGateway({ account: buildResolvedNostrAccount({ profile }) });
    expect(h.context.getStatus()).toMatchObject({ lifecycle: "starting", profile });
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
    expect(reply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Pairing code:"));
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
    expect(convertMarkdownTables.mock.calls).toEqual(visible ? [[visible, "off"]] : []);
    expect(reply.mock.calls).toEqual(expected ? [[expected]] : []);
  });
});

describe("nostr outbound", () => {
  it("suppresses an outbound internal-trace-only reply", () => {
    const { text, expected } = NOSTR_SANITIZER_CASES[3]!;
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
    await nostrPlugin.pairing!.notifyApproval!({ cfg, id: TEST_HEX_PUBLIC_KEY });
    expect(h.bus.sendDm).toHaveBeenLastCalledWith(
      TEST_HEX_PUBLIC_KEY,
      "Your pairing request has been approved!",
    );
  });

  it("rejects empty text after Markdown conversion", async () => {
    const h = await startGateway();
    await expect(send("***")).rejects.toThrow("requires non-empty text");
    expect(h.bus.sendDm).not.toHaveBeenCalled();
  });
});
