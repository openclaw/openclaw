import { TerminalChannelError } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId, ChannelPlugin } from "../../../../src/channels/plugins/types.js";
import { createChannelManager } from "../../../../src/gateway/server-channels.js";
import { createSubsystemLogger, runtimeForLogger } from "../../../../src/logging/subsystem.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry.js";
import {
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../../../src/routing/session-key.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";

// ---------------------------------------------------------------------------
// @slack/bolt mock — configurable start behaviour via hoisted mock ref
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const boltStartMock = vi
    .fn<[], Promise<void>>()
    .mockRejectedValue(new Error("An API error occurred: account_inactive"));
  return { boltStartMock };
});

vi.mock("@slack/bolt", () => {
  class SocketModeReceiver {
    client = { shuttingDown: false, on: vi.fn(), off: vi.fn() };
  }
  class HTTPReceiver {}
  class App {
    receiver: unknown;
    constructor(opts: { receiver?: unknown } = {}) {
      this.receiver = opts.receiver;
    }
    use = vi.fn();
    event = vi.fn();
    message = vi.fn();
    action = vi.fn();
    shortcut = vi.fn();
    command = vi.fn();
    options = vi.fn();
    error = vi.fn();
    start = hoisted.boltStartMock;
    stop = vi.fn().mockResolvedValue(undefined);
  }
  return { default: App, App, HTTPReceiver, SocketModeReceiver };
});

vi.mock("../accounts.js", () => ({
  resolveSlackAccount: vi.fn().mockReturnValue({
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test",
    appToken: "xapp-test",
    config: { mode: "socket" },
  }),
  resolveSlackAccountAllowFrom: vi.fn().mockReturnValue([]),
  resolveSlackAccountDmPolicy: vi.fn().mockReturnValue("pairing"),
}));

vi.mock("../client.js", () => ({
  resolveSlackWebClientOptions: vi.fn().mockReturnValue({}),
}));

import { monitorSlackProvider } from "./provider.js";

// ---------------------------------------------------------------------------
// Helpers for supervisor tests
// ---------------------------------------------------------------------------

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function createTestPlugin(
  startAccount: NonNullable<ChannelPlugin["gateway"]>["startAccount"],
): ChannelPlugin {
  return {
    id: "slack" as ChannelId,
    meta: {
      id: "slack" as ChannelId,
      label: "Slack",
      selectionLabel: "Slack",
      docsPath: "/channels/slack",
      blurb: "test stub",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => ({}),
      isEnabled: () => true,
    },
    gateway: { startAccount },
  };
}

function createTestManager(plugin: ChannelPlugin) {
  const log = createSubsystemLogger("gateway/provider-crash-test");
  const channelLogs = { slack: log } as unknown as Record<
    ChannelId,
    ReturnType<typeof createSubsystemLogger>
  >;
  const runtime = runtimeForLogger(log) as unknown as RuntimeEnv;
  const channelRuntimeEnvs = { slack: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: plugin.id, source: "test", plugin });
  setActivePluginRegistry(registry);
  return createChannelManager({
    loadConfig: () => ({}),
    channelLogs,
    channelRuntimeEnvs,
  });
}

// ---------------------------------------------------------------------------
// Provider terminal signal tests
// ---------------------------------------------------------------------------

describe("monitorSlackProvider — terminal error signal", () => {
  beforeEach(() => {
    hoisted.boltStartMock.mockReset();
  });

  it("rejects with TerminalChannelError on account_inactive (not a clean resolve)", async () => {
    hoisted.boltStartMock.mockRejectedValue(new Error("An API error occurred: account_inactive"));

    await expect(
      monitorSlackProvider({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        accountId: "default",
      }),
    ).rejects.toBeInstanceOf(TerminalChannelError);
  });

  it("rejects with TerminalChannelError on invalid_auth", async () => {
    hoisted.boltStartMock.mockRejectedValue(new Error("An API error occurred: invalid_auth"));

    await expect(
      monitorSlackProvider({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        accountId: "default",
      }),
    ).rejects.toBeInstanceOf(TerminalChannelError);
  });

  it("TerminalChannelError has terminal: true and wraps the original cause", async () => {
    const authErr = new Error("An API error occurred: account_inactive");
    hoisted.boltStartMock.mockRejectedValue(authErr);

    const err = await monitorSlackProvider({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      accountId: "default",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TerminalChannelError);
    expect((err as TerminalChannelError).terminal).toBe(true);
    expect((err as TerminalChannelError).cause).toBe(authErr);
  });
});

// ---------------------------------------------------------------------------
// Gateway supervisor restart suppression tests
// ---------------------------------------------------------------------------

describe("gateway supervisor — terminal error suppresses restart", () => {
  let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
  });

  afterEach(() => {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("does not set restartPending: true when startAccount throws TerminalChannelError", async () => {
    const startAccount = vi.fn(async () => {
      throw new TerminalChannelError("An API error occurred: account_inactive");
    });
    const manager = createTestManager(createTestPlugin(startAccount));

    await manager.startChannels();
    await flushMicrotasks();

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.slack?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toContain("account_inactive");
  });

  it("does not call startAccount again after a terminal error", async () => {
    const startAccount = vi.fn(async () => {
      throw new TerminalChannelError("An API error occurred: account_inactive");
    });
    const manager = createTestManager(createTestPlugin(startAccount));

    await manager.startChannels();
    await flushMicrotasks();

    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("still restarts on plain (non-terminal) errors", async () => {
    vi.useFakeTimers();
    try {
      const startAccount = vi.fn(async () => {
        throw new Error("transient network error");
      });
      const manager = createTestManager(createTestPlugin(startAccount));

      await manager.startChannels();
      await vi.advanceTimersByTimeAsync(0);

      const snapshot = manager.getRuntimeSnapshot();
      const account = snapshot.channelAccounts.slack?.[DEFAULT_ACCOUNT_ID];
      expect(account?.restartPending).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
