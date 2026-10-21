import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentialLease from "../shared/credential-lease.runtime.js";
import { createDiscordQaTransportAdapter } from "./adapter.runtime.js";
import * as channelE2e from "./channel-e2e.js";
import { createFlowInput, runtimeEnv } from "./discord-flow.test-support.js";
import * as testing from "./discord-live.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const driverId = "423456789012345678";
const sutId = runtimeEnv.sutApplicationId;

function mockAdapterIo(sutUserId = sutId) {
  const release = vi.fn(async () => {});
  const heartbeatStop = vi.fn(async () => {});
  vi.spyOn(credentialLease, "acquireQaCredentialLease").mockResolvedValue({
    kind: "discord",
    source: "convex",
    payload: runtimeEnv,
    assertHealthy() {},
    heartbeat: vi.fn(async () => {}),
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 120_000,
    release,
  });
  vi.spyOn(credentialLease, "startQaCredentialLeaseHeartbeat").mockReturnValue({
    getFailure: () => null,
    stop: heartbeatStop,
    throwIfFailed: vi.fn(),
    whenFailed: new Promise<Error>(() => {}),
  });
  vi.spyOn(testing, "getCurrentDiscordUser")
    .mockResolvedValueOnce({ id: driverId, bot: true })
    .mockResolvedValueOnce({ id: sutUserId, bot: true });
  const poll = vi.spyOn(testing, "pollChannelMessages");
  poll.mockRejectedValue(new Error("observer stopped"));
  const context = {
    channelId: "discord",
    driver: "live",
    outputDir: "/unused",
    credentials: {
      acquire: credentialLease.acquireQaCredentialLease,
      startHeartbeat: credentialLease.startQaCredentialLeaseHeartbeat,
    },
    messages: {
      addInboundMessage: vi.fn(),
      addOutboundMessage: vi.fn(),
      editMessage: vi.fn(),
    },
  } satisfies Parameters<typeof createDiscordQaTransportAdapter>[0];
  return { context, heartbeatStop, poll, release };
}

describe("Discord QA adapter cleanup", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("orders cleanup (heartbeat failure: %s)", async (heartbeatFails) => {
    const { context, heartbeatStop, poll, release } = mockAdapterIo();
    const pendingPoll = createDeferred<never>();
    poll.mockReturnValue(pendingPoll.promise);
    if (heartbeatFails) {
      heartbeatStop.mockRejectedValue(new Error("heartbeat shutdown failed"));
    }
    const adapter = await createDiscordQaTransportAdapter(context);
    expect(poll).toHaveBeenCalledOnce();

    const drained = vi.fn();
    const cleanup = adapter.cleanup?.().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    pendingPoll.reject(new Error("observer stopped"));
    await cleanup;

    expect(drained).toHaveBeenCalledOnce();
    expect(heartbeatStop).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const postStopCleanup = adapter.cleanupAfterGatewayStop?.();
    if (heartbeatFails) {
      await expect(postStopCleanup).rejects.toThrow("heartbeat shutdown failed");
    } else {
      await postStopCleanup;
    }
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(heartbeatStop).toHaveBeenCalledBefore(release);
  });

  it("defers native cleanup until Gateway stop and releases even when native cleanup fails", async () => {
    const { context, heartbeatStop, release } = mockAdapterIo();
    const outputDir = tempDirs.make("discord-adapter-cleanup-");
    const createSession = channelE2e.createDiscordChannelE2eSession;
    const nativeCleanup = vi.fn(async () => {
      throw new Error("native cleanup failed");
    });
    vi.spyOn(channelE2e, "createDiscordChannelE2eSession").mockImplementation((params) => {
      const session = createSession(params);
      vi.spyOn(session.driver, "doctor").mockResolvedValue({
        ok: true,
        checks: [],
        capabilities: { automated: [], observationOnly: [], manualClient: [], unavailable: [] },
      });
      vi.spyOn(session, "cleanup").mockImplementation(nativeCleanup);
      return session;
    });
    const adapter = await createDiscordQaTransportAdapter({
      ...context,
      adapterOptions: { agentE2e: true },
    });
    await adapter.prepareFlow?.(createFlowInput(outputDir));
    await adapter.cleanup?.();
    expect(nativeCleanup).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow("native cleanup failed");
    expect(nativeCleanup).toHaveBeenCalledBefore(heartbeatStop);
    expect(heartbeatStop).toHaveBeenCalledBefore(release);
  });

  it.each([
    [driverId, "requires two distinct bots"],
    ["523456789012345678", "application id must match"],
  ])("immediately releases for invalid SUT %s (%s)", async (invalidSutId, error) => {
    const { context, heartbeatStop, poll, release } = mockAdapterIo(invalidSutId);

    await expect(createDiscordQaTransportAdapter(context)).rejects.toThrow(error);

    expect(poll).not.toHaveBeenCalled();
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
