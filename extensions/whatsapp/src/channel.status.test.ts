import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebChannelStatus } from "./auto-reply/types.js";

const runtimeMocks = vi.hoisted(() => ({
  monitorWebChannel: vi.fn<typeof import("./auto-reply/monitor.js").monitorWebChannel>(),
  readWebAuthSnapshot: vi.fn(),
}));

vi.mock("./channel-runtime-loader.js", () => ({
  isWhatsAppAuthConfigured: vi.fn(async () => true),
  loadWhatsAppChannelRuntime: vi.fn(async () => runtimeMocks),
}));

import { whatsappPlugin } from "./channel.js";
import { setWhatsAppRuntime } from "./runtime.js";

const account = {
  accountId: "default",
  authDir: "/tmp/whatsapp-auth",
  enabled: true,
  name: "Default",
  sendReadReceipts: true,
  isLegacyAuthDir: false,
};
const accountParams = { account: account as never, cfg: {} };
const status = whatsappPlugin.status!;
const revoked = {
  configured: true,
  statusState: "not-linked",
  linked: false,
  healthState: "logged-out",
  lifecycle: "blocked",
};

describe("WhatsApp channel status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWhatsAppRuntime({
      channel: {},
      logging: { shouldLogVerbose: () => false },
    } as unknown as PluginRuntime);
    runtimeMocks.readWebAuthSnapshot.mockResolvedValue({
      state: "linked",
      authAgeMs: 10_000,
      selfId: { e164: "+15555550100", jid: "15555550100@s.whatsapp.net", lid: null },
    });
    runtimeMocks.monitorWebChannel.mockResolvedValue(undefined);
  });

  it("publishes identity with lifecycle updates and clears it after logout or stop", async () => {
    const ctx = createStartAccountContext({ account });
    runtimeMocks.monitorWebChannel.mockImplementation(async (...args) => {
      const emit = (next: Partial<WebChannelStatus>) =>
        args[6]?.statusSink?.({ running: true, connected: true, reconnectAttempts: 0, ...next });
      emit({ healthState: "healthy" });
      expect(ctx.getStatus()).toMatchObject({
        self: { e164: "+15555550100" },
        authAgeMs: 10_000,
      });
      for (const authAgeMs of [60_000, 1000, null]) {
        emit({ authAgeMs });
        expect(ctx.getStatus()).toMatchObject({ authAgeMs });
      }
      emit({ connected: false, healthState: "logged-out" });
      expect(ctx.getStatus()).toMatchObject({ self: null, authAgeMs: null, linked: false });
      emit({ running: false, connected: false, healthState: "stopped" });
      expect(ctx.getStatus()).toMatchObject({ self: null, authAgeMs: null });
    });
    await whatsappPlugin.gateway?.startAccount?.(ctx);
    expect(runtimeMocks.monitorWebChannel).toHaveBeenCalledOnce();
    expect(runtimeMocks.readWebAuthSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    { state: "not-linked", message: "Not linked (no WhatsApp Web session)." },
    { state: "unstable", message: "Auth state is still stabilizing." },
  ])("reports only the auth issue for $state", async ({ state, message }) => {
    runtimeMocks.readWebAuthSnapshot.mockResolvedValue({
      state,
      authAgeMs: null,
      selfId: { e164: null, jid: null, lid: null },
    });
    if (!status.defaultRuntime) {
      throw new Error("Missing WhatsApp default runtime");
    }
    const summary = await status.buildChannelSummary?.({
      ...accountParams,
      defaultAccountId: account.accountId,
      snapshot: status.defaultRuntime,
    });

    expect(summary).toMatchObject({
      statusState: state,
      healthState: "stopped",
      reconnectAttempts: 0,
      lastDisconnect: null,
      lastError: null,
    });
    expect(
      status.collectStatusIssues?.([{ ...summary, accountId: account.accountId, enabled: true }]),
    ).toEqual([expect.objectContaining({ kind: "auth", message })]);
  });

  it.each([
    { name: "an error", runtime: { lastError: "socket closed" } },
    { name: "a disconnect", runtime: { lastDisconnect: { at: 1_000, status: 408 } } },
    { name: "a retry", runtime: { reconnectAttempts: 1 } },
  ])("preserves the stopped warning after $name", async ({ runtime }) => {
    const snapshot = await status.buildAccountSnapshot?.({
      ...accountParams,
      runtime: { ...status.defaultRuntime, accountId: account.accountId, ...runtime },
    });

    if (!snapshot) {
      throw new Error("Missing WhatsApp account snapshot");
    }
    expect(status.collectStatusIssues?.([snapshot])).toEqual([
      expect.objectContaining({ kind: "auth", message: "Not linked (no WhatsApp Web session)." }),
      expect.objectContaining({ kind: "runtime", message: expect.stringContaining("stopped") }),
    ]);
  });

  it("does not project cached revoked auth as linked", async () => {
    const snapshot = {
      accountId: "default",
      running: false,
      connected: false,
      healthState: "logged-out",
      lifecycle: "blocked" as const,
      lastError: "status=401",
    };

    const summary = await status.buildChannelSummary?.({
      ...accountParams,
      defaultAccountId: "default",
      snapshot,
    });
    const accountSnapshot = await status.buildAccountSnapshot?.({
      ...accountParams,
      runtime: snapshot,
    });

    expect(summary).toMatchObject({
      ...revoked,
      authAgeMs: null,
      self: { e164: null, jid: null, lid: null },
    });
    expect(accountSnapshot).toMatchObject(revoked);
  });
});
