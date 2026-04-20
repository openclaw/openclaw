import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  readWebAuthExistsBestEffort: vi.fn(async () => ({ exists: false, timedOut: false })),
  readWebAuthSnapshotBestEffort: vi.fn(async () => ({
    linked: false,
    timedOut: false,
    authAgeMs: null,
    selfId: { e164: null, jid: null, lid: null },
  })),
  loadWhatsAppChannelRuntime: vi.fn(),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return {
    ...actual,
    loadWhatsAppChannelRuntime: hoisted.loadWhatsAppChannelRuntime,
  };
});

import { whatsappPlugin } from "./channel.js";

function createAccount(): ResolvedWhatsAppAccount {
  return {
    accountId: "default",
    enabled: true,
    sendReadReceipts: true,
    authDir: "/tmp/openclaw-whatsapp-status",
    isLegacyAuthDir: false,
  };
}

describe("whatsapp channel status", () => {
  beforeEach(() => {
    hoisted.readWebAuthExistsBestEffort.mockReset().mockResolvedValue({
      exists: false,
      timedOut: false,
    });
    hoisted.readWebAuthSnapshotBestEffort.mockReset().mockResolvedValue({
      linked: false,
      timedOut: false,
      authAgeMs: null,
      selfId: { e164: null, jid: null, lid: null },
    });
    hoisted.loadWhatsAppChannelRuntime.mockReset().mockImplementation(async () => ({
      readWebAuthExistsBestEffort: hoisted.readWebAuthExistsBestEffort,
      readWebAuthSnapshotBestEffort: hoisted.readWebAuthSnapshotBestEffort,
      logWebSelfId: vi.fn(),
      preflightWebLoginWithQrStart: vi.fn(),
      startWebLoginWithQr: vi.fn(),
      waitForWebLogin: vi.fn(),
      getActiveWebListener: vi.fn(),
      monitorWebChannel: vi.fn(),
    }));
  });

  it("keeps configured true and leaves linked unset when account snapshot auth times out", async () => {
    hoisted.readWebAuthExistsBestEffort.mockResolvedValueOnce({
      exists: false,
      timedOut: true,
    });

    const snapshot = await whatsappPlugin.status?.buildAccountSnapshot?.({
      account: createAccount(),
      cfg: {} as OpenClawConfig,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        accountId: "default",
        configured: true,
      }),
    );
    expect(snapshot?.linked).toBeUndefined();
  });

  it("keeps configured true and leaves linked unset in the channel summary when auth times out", async () => {
    hoisted.readWebAuthSnapshotBestEffort.mockResolvedValueOnce({
      linked: false,
      timedOut: true,
      authAgeMs: null,
      selfId: { e164: null, jid: null, lid: null },
    });

    const summary = await whatsappPlugin.status?.buildChannelSummary?.({
      account: createAccount(),
      cfg: {} as OpenClawConfig,
      defaultAccountId: "default",
      snapshot: {
        accountId: "default",
      },
    } as never);

    expect(summary).toEqual(
      expect.objectContaining({
        configured: true,
      }),
    );
    expect(summary?.linked).toBeUndefined();
  });
});
