import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  closeDriver: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseRelease: vi.fn(),
  startWhatsAppQaDriverSession: vi.fn(),
  unpackWhatsAppAuthArchive: vi.fn(),
}));

vi.mock("@openclaw/whatsapp/api.js", () => ({
  startWhatsAppQaDriverSession: mocks.startWhatsAppQaDriverSession,
}));

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp",
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
  }),
}));

vi.mock("./whatsapp-live.runtime.js", () => ({
  __testing: {
    buildWhatsAppQaConfig: vi.fn(() => ({})),
    parseWhatsAppQaCredentialPayload: vi.fn(),
    resolveWhatsAppQaMessageTargets: vi.fn(() => ({
      driverTarget: "15550000002@s.whatsapp.net",
      gatewayTarget: "+15550000001",
    })),
    resolveWhatsAppQaRuntimeEnv: vi.fn(),
    unpackWhatsAppAuthArchive: mocks.unpackWhatsAppAuthArchive,
    waitForWhatsAppChannelStable: vi.fn(),
  },
}));

import { createWhatsAppQaTransportAdapter } from "./adapter.runtime.js";

describe("WhatsApp QA transport adapter cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.acquireQaCredentialLease.mockResolvedValue({
      payload: {
        driverAuthArchiveBase64: "driver-auth",
        driverPhoneE164: "+15550000002",
        sutAuthArchiveBase64: "sut-auth",
        sutPhoneE164: "+15550000001",
      },
      release: mocks.leaseRelease,
    });
    vi.spyOn(fs, "mkdtemp").mockResolvedValue("/tmp/qa-auth");
    vi.spyOn(fs, "rm").mockResolvedValue();
    mocks.unpackWhatsAppAuthArchive.mockImplementation(
      async ({ label }: { label: string }) => `/tmp/qa-auth/${label}`,
    );
    mocks.startWhatsAppQaDriverSession.mockResolvedValue({
      close: mocks.closeDriver,
      getObservedMessages: () => [],
      sendText: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the lease and gateway auth files until gateway teardown succeeds", async () => {
    const adapter = await createWhatsAppQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);

    const cleanup = adapter.cleanup?.();
    await vi.advanceTimersByTimeAsync(500);
    await cleanup;

    expect(mocks.closeDriver).toHaveBeenCalledOnce();
    expect(mocks.heartbeatStop).not.toHaveBeenCalled();
    expect(mocks.leaseRelease).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();

    await adapter.cleanupAfterGatewayStop?.();

    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
    expect(fs.rm).toHaveBeenCalledWith("/tmp/qa-auth", { force: true, recursive: true });
  });

  it("releases the lease and removes staged auth when initialization cleanup fails", async () => {
    mocks.startWhatsAppQaDriverSession.mockRejectedValueOnce(new Error("driver start failed"));
    mocks.heartbeatStop.mockRejectedValueOnce(new Error("heartbeat stop failed"));

    await expect(
      createWhatsAppQaTransportAdapter({ adapterOptions: {}, messages: {} } as never),
    ).rejects.toThrow("heartbeat stop failed");

    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
    expect(fs.rm).toHaveBeenCalledWith("/tmp/qa-auth", { force: true, recursive: true });
  });
});
