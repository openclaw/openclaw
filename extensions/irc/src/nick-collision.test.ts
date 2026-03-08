/**
 * Tests for the IRC 433 "nickname already in use" fix, covering:
 *
 * 1. waitForAbortSignal — the primitive channel.ts uses to keep the
 *    startAccount promise alive until the gateway signals shutdown.
 *    Without this, the gateway sees an immediately-resolved promise, marks
 *    the channel stopped, and schedules an auto-restart — creating a second
 *    IRC connection with the same nick and triggering 433 errors.
 *
 * 2. sendMessageIrc reuses the live registered client (no transient connect).
 *
 * 3. probeIrc reuses the live client when available; uses the configured nick
 *    on a fresh connection so probe results mirror the real startup path.
 *
 * Socket-level 433 recovery tests are in nick-collision-connect.test.ts.
 * Client registry tests are in client-registry.test.ts.
 */

// ---------------------------------------------------------------------------
// Mocks for send/probe dependencies
// (vi.mock calls are hoisted by vitest — must appear before imports)
// ---------------------------------------------------------------------------
const mockDeps = vi.hoisted(() => {
  const loadConfig = vi.fn();
  const resolveMarkdownTableMode = vi.fn(() => "preserve");
  const convertMarkdownTables = vi.fn((text: string) => text);
  const record = vi.fn();
  return {
    loadConfig,
    resolveMarkdownTableMode,
    convertMarkdownTables,
    record,
    resolveIrcAccount: vi.fn(() => ({
      configured: true,
      accountId: "default",
      host: "irc.example.com",
      nick: "openclaw",
      port: 6697,
      tls: true,
      config: {},
    })),
    normalizeIrcMessagingTarget: vi.fn((v: string) => v.trim()),
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions: vi.fn(() => ({ nick: "openclaw_" })),
    getLiveIrcClient: vi.fn(),
  };
});

vi.mock("./runtime.js", () => ({
  getIrcRuntime: () => ({
    config: { loadConfig: mockDeps.loadConfig },
    channel: {
      text: {
        resolveMarkdownTableMode: mockDeps.resolveMarkdownTableMode,
        convertMarkdownTables: mockDeps.convertMarkdownTables,
      },
      activity: { record: mockDeps.record },
    },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: mockDeps.resolveIrcAccount,
}));

vi.mock("./normalize.js", () => ({
  normalizeIrcMessagingTarget: mockDeps.normalizeIrcMessagingTarget,
  isChannelTarget: vi.fn((v: string) => v.startsWith("#")),
}));

vi.mock("./client.js", () => ({
  connectIrcClient: mockDeps.connectIrcClient,
  buildIrcNickServCommands: vi.fn(() => []),
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: mockDeps.buildIrcConnectOptions,
}));

vi.mock("./client-registry.js", () => ({
  getLiveIrcClient: mockDeps.getLiveIrcClient,
  registerIrcClient: vi.fn(),
  unregisterIrcClient: vi.fn(),
}));

vi.mock("./protocol.js", async () => {
  const actual = await vi.importActual<typeof import("./protocol.js")>("./protocol.js");
  return {
    ...actual,
    makeIrcMessageId: () => "irc-test-msg-1",
  };
});

// ---------------------------------------------------------------------------
// Actual imports
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForAbortSignal } from "./abort-signal.js";
import type { IrcClient } from "./client.js";
import { probeIrc } from "./probe.js";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMockClient(ready = true): IrcClient {
  return {
    nick: "openclaw",
    isReady: vi.fn(() => ready),
    sendRaw: vi.fn(),
    join: vi.fn(),
    sendPrivmsg: vi.fn(),
    quit: vi.fn(),
    close: vi.fn(),
  };
}

function makeCfg(): CoreConfig {
  return {
    channels: {
      irc: {
        host: "irc.example.com",
        port: 6697,
        tls: true,
        nick: "openclaw",
        username: "oc",
        realname: "OpenClaw Bot",
      },
    },
  } as unknown as CoreConfig;
}

// ---------------------------------------------------------------------------
// 1. waitForAbortSignal — startAccount promise lifetime
// ---------------------------------------------------------------------------
describe("waitForAbortSignal — startAccount promise lifetime (fix for 433)", () => {
  it("keeps the promise pending while the AbortSignal is live", async () => {
    const ac = new AbortController();
    let resolved = false;

    const pending = waitForAbortSignal(ac.signal).then(() => {
      resolved = true;
    });

    // Flush microtasks — the promise must NOT be resolved yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Simulate gateway shutdown.
    ac.abort();
    await pending;
    expect(resolved).toBe(true);
  });

  it("resolves immediately when the signal is already aborted (stopped account)", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(waitForAbortSignal(ac.signal)).resolves.toBeUndefined();
  });

  it("resolves immediately when no signal is provided (backward-compat path)", async () => {
    await expect(waitForAbortSignal(undefined)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. sendMessageIrc — live client reuse
// ---------------------------------------------------------------------------
describe("sendMessageIrc — live client reuse (433 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps.resolveIrcAccount.mockReturnValue({
      configured: true,
      accountId: "default",
      host: "irc.example.com",
      nick: "openclaw",
      port: 6697,
      tls: true,
      config: {},
    });
    mockDeps.normalizeIrcMessagingTarget.mockImplementation((v: string) => v.trim());
    mockDeps.convertMarkdownTables.mockImplementation((text: string) => text);
  });

  it("uses the registered live client and does NOT call connectIrcClient", async () => {
    const liveClient = makeMockClient(true);
    mockDeps.getLiveIrcClient.mockReturnValue(liveClient);

    const result = await sendMessageIrc("#general", "hello");

    expect(mockDeps.connectIrcClient).not.toHaveBeenCalled();
    expect(liveClient.sendPrivmsg).toHaveBeenCalledWith("#general", "hello");
    expect(result.target).toBe("#general");
  });

  it("opens a transient connection and quits after sending when no live client is registered", async () => {
    mockDeps.getLiveIrcClient.mockReturnValue(undefined);
    const transientClient = makeMockClient(true);
    mockDeps.connectIrcClient.mockResolvedValue(transientClient);

    await sendMessageIrc("#ops", "ping");

    expect(mockDeps.connectIrcClient).toHaveBeenCalledOnce();
    expect(transientClient.sendPrivmsg).toHaveBeenCalledWith("#ops", "ping");
    expect(transientClient.quit).toHaveBeenCalledWith("sent");
  });

  it("opens a transient connection when getLiveIrcClient returns undefined (stale client evicted by registry)", async () => {
    mockDeps.getLiveIrcClient.mockReturnValue(undefined);
    const transientClient = makeMockClient(true);
    mockDeps.connectIrcClient.mockResolvedValue(transientClient);

    await sendMessageIrc("alice", "hi there");

    expect(mockDeps.connectIrcClient).toHaveBeenCalledOnce();
    expect(transientClient.quit).toHaveBeenCalled();
  });

  it("prefers an explicitly passed client over the live registry client", async () => {
    const liveClient = makeMockClient(true);
    const explicitClient = makeMockClient(true);
    mockDeps.getLiveIrcClient.mockReturnValue(liveClient);

    await sendMessageIrc("#room", "test", { client: explicitClient });

    expect(explicitClient.sendPrivmsg).toHaveBeenCalledWith("#room", "test");
    expect(liveClient.sendPrivmsg).not.toHaveBeenCalled();
    expect(mockDeps.connectIrcClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. probeIrc — live client reuse and configured-nick on fresh connection
// ---------------------------------------------------------------------------
describe("probeIrc — live client reuse and nick collision avoidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps.resolveIrcAccount.mockReturnValue({
      configured: true,
      accountId: "default",
      host: "irc.example.com",
      nick: "openclaw",
      port: 6697,
      tls: true,
      config: {},
    });
  });

  it("returns ok:true with latencyMs:0 when a live client is already registered", async () => {
    const liveClient = makeMockClient(true);
    mockDeps.getLiveIrcClient.mockReturnValue(liveClient);

    const result = await probeIrc(makeCfg());

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBe(0);
    expect(mockDeps.connectIrcClient).not.toHaveBeenCalled();
  });

  it("opens a fresh connection using the configured nick when no live client exists", async () => {
    mockDeps.getLiveIrcClient.mockReturnValue(undefined);
    const probeClient = makeMockClient(true);
    mockDeps.connectIrcClient.mockResolvedValue(probeClient);

    const result = await probeIrc(makeCfg());

    expect(result.ok).toBe(true);
    expect(mockDeps.connectIrcClient).toHaveBeenCalledOnce();

    // No nick override is passed — the configured nick is used directly so
    // the probe accurately reflects whether the real startup nick is available.
    // The built-in client 433 handler (NickServ GHOST + nick_ fallback) handles
    // nick collision the same way monitorIrcProvider would.
    const overrides = mockDeps.buildIrcConnectOptions.mock.calls[0]?.[1] as
      | { nick?: string }
      | undefined;
    expect(overrides?.nick).toBeUndefined();

    expect(probeClient.quit).toHaveBeenCalledWith("probe");
  });

  it("returns ok:false with an error message when the probe connection fails", async () => {
    mockDeps.getLiveIrcClient.mockReturnValue(undefined);
    mockDeps.connectIrcClient.mockRejectedValue(new Error("connection refused"));

    const result = await probeIrc(makeCfg());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
  });

  it("returns ok:false with 'missing host or nick' when account is not configured", async () => {
    mockDeps.resolveIrcAccount.mockReturnValue({
      configured: false,
      accountId: "default",
      host: "",
      nick: "",
      port: 6697,
      tls: false,
      config: {},
    });

    const result = await probeIrc(makeCfg());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing host or nick/);
    expect(mockDeps.connectIrcClient).not.toHaveBeenCalled();
  });
});
