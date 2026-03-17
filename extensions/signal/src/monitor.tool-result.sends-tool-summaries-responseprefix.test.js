import { describe, expect, it, vi } from "vitest";
import { peekSystemEvents } from "../../../src/infra/system-events.js";
import { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
import { normalizeE164 } from "../../../src/utils.js";
import {
  createMockSignalDaemonHandle,
  config,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig
} from "./monitor.tool-result.test-harness.js";
installSignalToolResultTestHooks();
const { monitorSignalProvider } = await import("./monitor.js");
const {
  replyMock,
  sendMock,
  streamMock,
  updateLastRouteMock,
  upsertPairingRequestMock,
  waitForTransportReadyMock,
  spawnSignalDaemonMock
} = getSignalToolResultTestMocks();
const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code) => {
      throw new Error(`exit ${code}`);
    })
  };
}
function setSignalAutoStartConfig(overrides = {}) {
  setSignalToolResultTestConfig(createSignalConfig(overrides));
}
function createSignalConfig(overrides = {}) {
  const base = config;
  const channels = base.channels ?? {};
  const signal = channels.signal ?? {};
  return {
    ...base,
    channels: {
      ...channels,
      signal: {
        ...signal,
        autoStart: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides
      }
    }
  };
}
function createAutoAbortController() {
  const abortController = new AbortController();
  streamMock.mockImplementation(async () => {
    abortController.abort();
    return;
  });
  return abortController;
}
async function runMonitorWithMocks(opts) {
  return monitorSignalProvider({
    config,
    ...opts
  });
}
async function receiveSignalPayloads(params) {
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload)
      });
    }
    abortController.abort();
  });
  await runMonitorWithMocks({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts
  });
  await flush();
}
function getDirectSignalEventsFor(sender) {
  const route = resolveAgentRoute({
    cfg: config,
    channel: "signal",
    accountId: "default",
    peer: { kind: "direct", id: normalizeE164(sender) }
  });
  return peekSystemEvents(route.sessionKey);
}
function makeBaseEnvelope(overrides = {}) {
  return {
    sourceNumber: "+15550001111",
    sourceName: "Ada",
    timestamp: 1,
    ...overrides
  };
}
async function receiveSingleEnvelope(envelope, opts) {
  await receiveSignalPayloads({
    payloads: [{ envelope }],
    opts
  });
}
function expectNoReplyDeliveryOrRouteUpdate() {
  expect(replyMock).not.toHaveBeenCalled();
  expect(sendMock).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}
function setReactionNotificationConfig(mode, extra = {}) {
  setSignalToolResultTestConfig(
    createSignalConfig({
      autoStart: false,
      dmPolicy: "open",
      allowFrom: ["*"],
      reactionNotifications: mode,
      ...extra
    })
  );
}
function expectWaitForTransportReadyTimeout(timeoutMs) {
  expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
  expect(waitForTransportReadyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs
    })
  );
}
describe("monitorSignalProvider tool results", () => {
  it("uses bounded readiness checks when auto-starting the daemon", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime
    });
    expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
    expect(waitForTransportReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "signal daemon",
        timeoutMs: 3e4,
        logAfterMs: 1e4,
        logIntervalMs: 1e4,
        pollIntervalMs: 150,
        runtime,
        abortSignal: expect.any(AbortSignal)
      })
    );
  });
  it("uses startupTimeoutMs override when provided", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 6e4 });
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
      startupTimeoutMs: 9e4
    });
    expectWaitForTransportReadyTimeout(9e4);
  });
  it("caps startupTimeoutMs at 2 minutes", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 18e4 });
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime
    });
    expectWaitForTransportReadyTimeout(12e4);
  });
  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
        isExited: () => true
      })
    );
    waitForTransportReadyMock.mockImplementationOnce(
      async (params) => {
        await new Promise((_resolve, reject) => {
          if (params.abortSignal?.aborted) {
            reject(params.abortSignal.reason);
            return;
          }
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(params.abortSignal?.reason ?? new Error("aborted")),
            { once: true }
          );
        });
      }
    );
    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime
      })
    ).rejects.toThrow(/signal daemon exited/i);
  });
  it("treats daemon exit after user abort as clean shutdown", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = new AbortController();
    let exited = false;
    let resolveExit;
    const exitedPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const stop = vi.fn(() => {
      if (exited) {
        return;
      }
      exited = true;
      resolveExit({ source: "process", code: null, signal: "SIGTERM" });
    });
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        stop,
        exited: exitedPromise,
        isExited: () => exited
      })
    );
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });
    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
        abortSignal: abortController.signal
      })
    ).resolves.toBeUndefined();
  });
  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello"
            }
          }
        }
      ]
    });
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });
  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setSignalToolResultTestConfig(
      createSignalConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] })
    );
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello"
            }
          }
        }
      ]
    });
    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Your Signal number: +15550001111");
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  });
  it("ignores reaction-only messages", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "\u{1F44D}",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2
      }
    });
    expectNoReplyDeliveryOrRouteUpdate();
  });
  it("ignores reaction-only dataMessage.reaction events (don\u2019t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      dataMessage: {
        reaction: {
          emoji: "\u{1F44D}",
          targetAuthor: "+15550002222",
          targetSentTimestamp: 2
        },
        attachments: [{}]
      }
    });
    expectNoReplyDeliveryOrRouteUpdate();
  });
  it("enqueues system events for reaction notifications", async () => {
    setReactionNotificationConfig("all");
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "\u2705",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2
      }
    });
    const events = getDirectSignalEventsFor("+15550001111");
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(true);
  });
  it.each([
    {
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is allowlist",
      mode: "all",
      extra: { dmPolicy: "allowlist", allowFrom: ["+15550007777"] },
      targetAuthor: "+15550002222",
      shouldEnqueue: false
    },
    {
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is pairing",
      mode: "own",
      extra: {
        dmPolicy: "pairing",
        allowFrom: [],
        account: "+15550009999"
      },
      targetAuthor: "+15550009999",
      shouldEnqueue: false
    },
    {
      name: "allows reaction notifications for allowlisted senders when dmPolicy is allowlist",
      mode: "all",
      extra: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] },
      targetAuthor: "+15550002222",
      shouldEnqueue: true
    }
  ])("$name", async ({ mode, extra, targetAuthor, shouldEnqueue }) => {
    setReactionNotificationConfig(mode, extra);
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "\u2705",
        targetAuthor,
        targetSentTimestamp: 2
      }
    });
    const events = getDirectSignalEventsFor("+15550001111");
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(shouldEnqueue);
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });
  it("notifies on own reactions when target includes uuid + phone", async () => {
    setReactionNotificationConfig("own", { account: "+15550002222" });
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "\u2705",
        targetAuthor: "+15550002222",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
        targetSentTimestamp: 2
      }
    });
    const events = getDirectSignalEventsFor("+15550001111");
    expect(events.some((text) => text.includes("Signal reaction added"))).toBe(true);
  });
  it("processes messages when reaction metadata is present", async () => {
    replyMock.mockResolvedValue({ text: "pong" });
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            reactionMessage: {
              emoji: "\u{1F44D}",
              targetAuthor: "+15550002222",
              targetSentTimestamp: 2
            },
            dataMessage: {
              message: "ping"
            }
          }
        }
      ]
    });
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });
  it("does not resend pairing code when a request is already pending", async () => {
    setSignalToolResultTestConfig(
      createSignalConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] })
    );
    upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: true }).mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    const payload = {
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Ada",
        timestamp: 1,
        dataMessage: {
          message: "hello"
        }
      }
    };
    await receiveSignalPayloads({
      payloads: [
        payload,
        {
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 }
        }
      ]
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
