import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";
import type { ResolvedQQBotAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  drainPendingDeliveries: vi.fn(async () => {}),
  startGateway: vi.fn(async () => {}),
  loadCredentialBackup: vi.fn(),
  saveCredentialBackup: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: mocks.drainPendingDeliveries,
}));

vi.mock("./bridge/gateway.js", () => ({
  startGateway: mocks.startGateway,
}));

vi.mock("./engine/config/credential-backup.js", () => ({
  loadCredentialBackup: mocks.loadCredentialBackup,
  saveCredentialBackup: mocks.saveCredentialBackup,
}));

type GatewayStartOptions = {
  onReady?: () => void;
  onResumed?: () => void;
};

type PendingDeliveryEntry = {
  channel: string;
  accountId?: string | null;
  lastError?: string | null;
};

type ReconnectDrainOptions = {
  drainKey: string;
  logLabel: string;
  cfg: OpenClawConfig;
  selectEntry: (entry: PendingDeliveryEntry) => unknown;
};

const cfg = {
  channels: {
    qqbot: {
      enabled: true,
      appId: "app",
      clientSecret: "secret",
    },
  },
} as OpenClawConfig;

function buildAccount(): ResolvedQQBotAccount {
  return {
    accountId: "default",
    enabled: true,
    appId: "app",
    clientSecret: "secret",
    secretSource: "config",
    markdownSupport: true,
    config: {
      enabled: true,
      appId: "app",
      clientSecret: "secret",
    },
  };
}

async function startAccountAndGetGatewayOptions(): Promise<GatewayStartOptions> {
  await qqbotPlugin.gateway?.startAccount?.(
    createStartAccountContext({
      account: buildAccount(),
      cfg,
    }),
  );
  expect(mocks.startGateway).toHaveBeenCalledOnce();
  return (mocks.startGateway.mock.calls as unknown[][])[0]?.[0] as GatewayStartOptions;
}

function latestDrainOptions(): ReconnectDrainOptions {
  const call = mocks.drainPendingDeliveries.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected drainPendingDeliveries call");
  }
  return (call as unknown[])[0] as ReconnectDrainOptions;
}

function expectReconnectDrainSelection(selectEntry: (entry: PendingDeliveryEntry) => unknown) {
  expect(
    selectEntry({
      channel: "qqbot",
      accountId: "default",
      lastError: "gateway disconnected",
    } as PendingDeliveryEntry),
  ).toEqual({
    match: true,
    bypassBackoff: true,
  });
  expect(
    selectEntry({
      channel: "telegram",
      accountId: "default",
      lastError: "gateway disconnected",
    } as PendingDeliveryEntry),
  ).toEqual({
    match: false,
    bypassBackoff: true,
  });
  expect(
    selectEntry({
      channel: "qqbot",
      accountId: "other",
      lastError: "not connected",
    } as PendingDeliveryEntry),
  ).toEqual({
    match: false,
    bypassBackoff: true,
  });
  expect(
    selectEntry({
      channel: "qqbot",
      accountId: "default",
      lastError: "rate limited",
    } as PendingDeliveryEntry),
  ).toEqual({
    match: true,
    bypassBackoff: false,
  });
  expect(
    selectEntry({
      channel: "qqbot",
      accountId: undefined,
      lastError: "gateway disconnected",
    } as PendingDeliveryEntry),
  ).toEqual({
    match: true,
    bypassBackoff: true,
  });
}

describe("qqbot gateway reconnect delivery drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drains matching pending deliveries when the gateway becomes ready", async () => {
    const options = await startAccountAndGetGatewayOptions();
    options.onReady?.();

    await vi.waitFor(() => {
      expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    });
    const drainOptions = latestDrainOptions();
    expect(drainOptions.drainKey).toBe("qqbot:default");
    expect(drainOptions.logLabel).toBe("QQBot reconnect drain");
    expect(drainOptions.cfg).toBe(cfg);
    expectReconnectDrainSelection(drainOptions.selectEntry);
  });

  it("drains matching pending deliveries when the gateway resumes", async () => {
    const options = await startAccountAndGetGatewayOptions();
    options.onResumed?.();

    await vi.waitFor(() => {
      expect(mocks.drainPendingDeliveries).toHaveBeenCalledOnce();
    });
    const drainOptions = latestDrainOptions();
    expect(drainOptions.drainKey).toBe("qqbot:default");
    expect(drainOptions.logLabel).toBe("QQBot reconnect drain");
    expect(drainOptions.cfg).toBe(cfg);
    expectReconnectDrainSelection(drainOptions.selectEntry);
  });
});
