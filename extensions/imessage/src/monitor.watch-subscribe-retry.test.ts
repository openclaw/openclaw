import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
import { recordIMessageCatchupCursor } from "./monitor/catchup-cursor.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachIMessageMonitorAbortHandlerMock = vi.hoisted(() =>
  vi.fn<typeof attachIMessageMonitorAbortHandler>(() => () => {}),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachIMessageMonitorAbortHandlerMock,
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

type MockIMessageRpcClient = IMessageRpcClient & {
  request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>;
  waitForClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createRpcClient(overrides?: {
  request?: (method: string) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}): MockIMessageRpcClient {
  const client = {
    request: vi.fn(
      overrides?.request ??
        (async () => {
          return { subscription: 1 };
        }),
    ),
    waitForClose: vi.fn(
      overrides?.waitForClose ??
        (async () => {
          return undefined;
        }),
    ),
    stop: vi.fn(async () => {}),
  };
  return client as unknown as MockIMessageRpcClient;
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    attachIMessageMonitorAbortHandlerMock.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    const dirs = tmpDirs;
    tmpDirs = [];
    return Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))).then(
      () => undefined,
    );
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.resetModules();
  });

  it("retries a transient watch.subscribe startup timeout without tearing down the monitor", async () => {
    const runtime = createRuntime();
    const firstClient = createRpcClient({
      request: async () => {
        throw new Error("imsg rpc timeout (watch.subscribe)");
      },
    });
    const secondClient = createRpcClient();

    createIMessageRpcClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const monitorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    });

    await monitorPromise;

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.waitForClose).toHaveBeenCalledTimes(1);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("watch.subscribe startup failed"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("imessage: monitor failed"),
    );
  });

  it("resumes watch.subscribe from the persisted catchup cursor", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-monitor-"));
    tmpDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await recordIMessageCatchupCursor({ accountId: "main", messageId: 9000 });
    const runtime = createRuntime();
    const client = createRpcClient();
    createIMessageRpcClientMock.mockResolvedValueOnce(client);

    const monitorPromise = monitorIMessageProvider({
      accountId: "main",
      config: {
        channels: {
          imessage: {
            catchup: {
              maxAgeMinutes: 30,
            },
          },
        },
      } as never,
      runtime: runtime as never,
    });

    await monitorPromise;

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      expect.objectContaining({
        attachments: false,
        since_rowid: 9000,
        start: expect.any(String),
      }),
      { timeoutMs: 10_000 },
    );
  });

  it("still fails after bounded startup retries are exhausted", async () => {
    const runtime = createRuntime();
    createIMessageRpcClientMock.mockImplementation(async () =>
      createRpcClient({
        request: async () => {
          throw new Error("imsg rpc timeout (watch.subscribe)");
        },
      }),
    );

    const monitorErrorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    }).catch((error) => error);

    const monitorError = await monitorErrorPromise;

    expect(monitorError).toBeInstanceOf(Error);
    expect((monitorError as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(3);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("imessage: monitor failed"));
  });
});
