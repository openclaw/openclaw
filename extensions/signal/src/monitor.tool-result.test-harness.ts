import { resetSystemEventsForTest } from "openclaw/plugin-sdk/infra-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import type { MockFn } from "openclaw/plugin-sdk/testing";
import { beforeEach, vi } from "vitest";
import type { SignalDaemonExitEvent, SignalDaemonHandle } from "./daemon.js";

type SignalToolResultTestMocks = {
  waitForTransportReadyMock: MockFn;
  sendMock: MockFn;
  replyMock: MockFn;
  updateLastRouteMock: MockFn;
  readAllowFromStoreMock: MockFn;
  upsertPairingRequestMock: MockFn;
  streamMock: MockFn;
  signalCheckMock: MockFn;
  signalRpcRequestMock: MockFn;
  spawnSignalDaemonMock: MockFn;
};

const waitForTransportReadyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const sendMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const replyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const updateLastRouteMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const readAllowFromStoreMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const upsertPairingRequestMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const streamMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalCheckMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalRpcRequestMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const spawnSignalDaemonMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;

export function getSignalToolResultTestMocks(): SignalToolResultTestMocks {
  return {
    waitForTransportReadyMock,
    sendMock,
    replyMock,
    updateLastRouteMock,
    readAllowFromStoreMock,
    upsertPairingRequestMock,
    streamMock,
    signalCheckMock,
    signalRpcRequestMock,
    spawnSignalDaemonMock,
  };
}

export let config: Record<string, unknown> = {};

export function setSignalToolResultTestConfig(next: Record<string, unknown>) {
  config = next;
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function createMockSignalDaemonHandle(
  overrides: {
    stop?: MockFn;
    exited?: Promise<SignalDaemonExitEvent>;
    isExited?: () => boolean;
  } = {},
): SignalDaemonHandle {
  const stop = overrides.stop ?? (vi.fn() as unknown as MockFn);
  const exited = overrides.exited ?? new Promise<SignalDaemonExitEvent>(() => {});
  const isExited = overrides.isExited ?? (() => false);
  return {
    stop: stop as unknown as () => void,
    exited,
    isExited,
  };
}

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => config,
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    waitForTransportReady: (...args: unknown[]) => waitForTransportReadyMock(...args),
  };
});

export function installSignalToolResultModuleMocks() {
  const runSignalSseLoopMockImpl = async (params: {
    abortSignal?: AbortSignal;
    policy?: { initialMs?: number; maxMs?: number; factor?: number };
    runtime?: { error?: (message: string) => void; log?: (message: string) => void };
    onEvent: (event: unknown) => void;
  }) => {
    const initialMs = Math.max(1, params.policy?.initialMs ?? 1_000);
    const maxMs = Math.max(initialMs, params.policy?.maxMs ?? 10_000);
    const factor = Math.max(1, params.policy?.factor ?? 2);
    let attempt = 0;

    const sleep = async (ms: number) =>
      await new Promise<void>((resolve) => {
        if (params.abortSignal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => resolve(), ms);
        params.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    while (!params.abortSignal?.aborted) {
      try {
        await streamMock({
          onEvent: params.onEvent,
          abortSignal: params.abortSignal,
        });
        if (params.abortSignal?.aborted) {
          return;
        }
        attempt += 1;
        const delayMs = Math.min(maxMs, initialMs * factor ** Math.max(0, attempt - 1));
        await sleep(delayMs);
      } catch (err) {
        if (params.abortSignal?.aborted) {
          return;
        }
        params.runtime?.error?.(`Signal SSE stream error: ${String(err)}`);
        attempt += 1;
        const delayMs = Math.min(maxMs, initialMs * factor ** Math.max(0, attempt - 1));
        params.runtime?.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
        await sleep(delayMs);
      }
    }
  };

  vi.doMock("./send.js", () => ({
    sendMessageSignal: (...args: unknown[]) => sendMock(...args),
    sendTypingSignal: vi.fn().mockResolvedValue(true),
    sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
  }));
  vi.doMock("./send.ts", () => ({
    sendMessageSignal: (...args: unknown[]) => sendMock(...args),
    sendTypingSignal: vi.fn().mockResolvedValue(true),
    sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
  }));

  vi.doMock("./client.js", () => ({
    streamSignalEvents: (...args: unknown[]) => streamMock(...args),
    signalCheck: (...args: unknown[]) => signalCheckMock(...args),
    signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
  }));
  vi.doMock("./client.ts", () => ({
    streamSignalEvents: (...args: unknown[]) => streamMock(...args),
    signalCheck: (...args: unknown[]) => signalCheckMock(...args),
    signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
  }));

  vi.doMock("./sse-reconnect.js", () => ({
    runSignalSseLoop: (...args: unknown[]) =>
      runSignalSseLoopMockImpl(
        args[0] as {
          abortSignal?: AbortSignal;
          policy?: { initialMs?: number; maxMs?: number; factor?: number };
          runtime?: { error?: (message: string) => void; log?: (message: string) => void };
          onEvent: (event: unknown) => void;
        },
      ),
  }));
  vi.doMock("./sse-reconnect.ts", () => ({
    runSignalSseLoop: (...args: unknown[]) =>
      runSignalSseLoopMockImpl(
        args[0] as {
          abortSignal?: AbortSignal;
          policy?: { initialMs?: number; maxMs?: number; factor?: number };
          runtime?: { error?: (message: string) => void; log?: (message: string) => void };
          onEvent: (event: unknown) => void;
        },
      ),
  }));

  vi.doMock("./daemon.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./daemon.js")>();
    return {
      ...actual,
      spawnSignalDaemon: (...args: unknown[]) => spawnSignalDaemonMock(...args),
    };
  });
  vi.doMock("./daemon.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./daemon.ts")>();
    return {
      ...actual,
      spawnSignalDaemon: (...args: unknown[]) => spawnSignalDaemonMock(...args),
    };
  });
}

export function installSignalToolResultTestHooks() {
  beforeEach(() => {
    resetInboundDedupe();
    config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] },
      },
    };

    sendMock.mockReset().mockResolvedValue(undefined);
    replyMock.mockReset();
    updateLastRouteMock.mockReset();
    streamMock.mockReset();
    signalCheckMock.mockReset().mockResolvedValue({});
    signalRpcRequestMock.mockReset().mockResolvedValue({});
    spawnSignalDaemonMock.mockReset().mockReturnValue(createMockSignalDaemonHandle());
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);

    resetSystemEventsForTest();
  });
}
