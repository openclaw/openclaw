import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  createSlackWebClient: vi.fn(() => ({})),
  createSlackWriteClient: vi.fn(() => ({})),
  getSlackIdentity: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseRelease: vi.fn(),
  listSlackMessages: vi.fn(),
}));

vi.mock("@openclaw/slack/api.js", () => ({
  createSlackWebClient: mocks.createSlackWebClient,
  createSlackWriteClient: mocks.createSlackWriteClient,
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
  }),
}));

vi.mock("./slack-live.runtime.js", () => ({
  __testing: {
    buildSlackQaConfig: vi.fn(() => ({})),
    getSlackIdentity: mocks.getSlackIdentity,
    listSlackMessages: mocks.listSlackMessages,
    listSlackThreadMessages: vi.fn(),
    parseSlackQaCredentialPayload: vi.fn(),
    resolveSlackQaRuntimeEnv: vi.fn(),
    sendSlackChannelMessage: vi.fn(),
    waitForSlackChannelStable: vi.fn(),
  },
}));

import { createSlackQaTransportAdapter } from "./adapter.runtime.js";

describe("Slack QA transport adapter cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireQaCredentialLease.mockResolvedValue({
      payload: {
        channelId: "C123",
        driverBotToken: "driver-token",
        sutAppToken: "sut-app-token",
        sutBotToken: "sut-token",
      },
      release: mocks.leaseRelease,
    });
    mocks.getSlackIdentity
      .mockResolvedValueOnce({ userId: "U-driver" })
      .mockResolvedValueOnce({ userId: "U-sut" });
  });

  it("holds the credential lease until gateway teardown has completed", async () => {
    let resolvePoll: ((messages: unknown[]) => void) | undefined;
    mocks.listSlackMessages.mockImplementation(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          resolvePoll = resolve;
        }),
    );

    const adapter = await createSlackQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);
    await vi.waitFor(() => expect(resolvePoll).toBeTypeOf("function"));

    const cleanup = adapter.cleanup?.();
    resolvePoll?.([]);
    await cleanup;

    expect(mocks.heartbeatStop).not.toHaveBeenCalled();
    expect(mocks.leaseRelease).not.toHaveBeenCalled();

    await adapter.cleanupAfterGatewayStop?.();

    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });
});
