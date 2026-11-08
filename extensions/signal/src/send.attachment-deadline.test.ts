import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signalAccountConfig as accountConfig } from "./signal-rpc.test-support.js";

// Only the text-only path is mocked; the real HTTP suite below runs the real
// attachment resolver so the large file is actually read and staged.
const signalRpcRequestMock = vi.hoisted(() => vi.fn());

vi.mock("./client-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client-adapter.js")>();
  return {
    ...actual,
    signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
  };
});

const { sendMessageSignal } = await import("./send.js");
const SIGNAL_TEST_CFG = accountConfig("external-native", "http://signal.test");
const recipient = "+155****4567";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const send = (text = "hello", options: Partial<Parameters<typeof sendMessageSignal>[2]> = {}) =>
  sendMessageSignal(recipient, text, { cfg: SIGNAL_TEST_CFG, ...options });

function sendOpts(): Record<string, unknown> {
  return (signalRpcRequestMock.mock.calls.at(-1)?.[2] ?? {}) as Record<string, unknown>;
}

describe("sendMessageSignal attachment deadline", () => {
  it("leaves text-only sends on the default Signal RPC deadline", async () => {
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567893 });
    await send();
    expect(sendOpts()).not.toHaveProperty("timeoutMs", expect.anything());
  });

  it.each([
    ["the default 8 MiB cap", undefined, 62_000],
    ["a raised 41 MiB cap", 41 * 1024 * 1024, 194_000],
  ] as const)("derives an upload-aware deadline for %s", async (_name, maxBytes, expected) => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = tempDirs.make("signal-deadline-unit-");
    const mediaPath = join(dir, "doc.pdf");
    await writeFile(mediaPath, Buffer.from("%PDF-1.4\n% fake\n"));
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567894 });
    await send("", {
      mediaUrl: mediaPath,
      mediaLocalRoots: [dir],
      ...(maxBytes ? { maxBytes } : {}),
    });
    expect(sendOpts()).toMatchObject({ timeoutMs: expected });
  });

  it("keeps an explicit caller timeout on attachment sends", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = tempDirs.make("signal-deadline-explicit-");
    const mediaPath = join(dir, "doc.pdf");
    await writeFile(mediaPath, Buffer.from("%PDF-1.4\n% fake\n"));
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567896 });
    await send("", { mediaUrl: mediaPath, mediaLocalRoots: [dir], timeoutMs: 1_500 });
    expect(sendOpts()).toMatchObject({ timeoutMs: 1_500 });
  });
});

describe("Signal attachment send deadline over real HTTP RPC", () => {
  // signal-cli answers `send` only after the upload finishes, so a slow upload
  // looks like an idle request. The 10s default aborted these; #195284 reports
  // a 41 MB PDF reported failed yet delivered ~30s later.
  const SLOW_UPLOAD_MS = 12_000;

  async function slowUploadServer() {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = tempDirs.make("signal-send-deadline-");
    const mediaPath = join(dir, "large.pdf");
    // A real file so the real resolver reads and stages it, as signal-cli would.
    await writeFile(mediaPath, Buffer.alloc(41 * 1024 * 1024, 0x20));
    // `await using` would dispose right after the awaited expression resolves,
    // so the server must outlive the send; the caller closes it explicitly.
    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { signalJsonServer: createRpcServer, listenSignalServer } =
      await import("./signal-rpc.test-support.js");
    const seen: Record<string, unknown>[] = [];
    const server = createRpcServer((payload, _request, response) => {
      seen.push(payload as Record<string, unknown>);
      setTimeout(() => {
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { timestamp: 1700000099999 } }),
        );
      }, SLOW_UPLOAD_MS);
    });
    const cfg = await listenSignalServer(server, "external-native");
    const { sendMessageSignal: sendReal } = await import("./send.js");
    return {
      mediaPath,
      dir,
      seen,
      send: (text: string, options: Record<string, unknown>) =>
        sendReal(recipient, text, { cfg: cfg as never, ...options } as never),
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  it("delivers a 41 MB attachment whose upload outlasts the old 10s deadline", async () => {
    const rpc = await slowUploadServer();
    try {
      const startedAt = Date.now();
      const result = await rpc.send("hello", {
        mediaUrl: rpc.mediaPath,
        mediaLocalRoots: [rpc.dir],
        maxBytes: 60 * 1024 * 1024,
      });
      expect(result).toMatchObject({ messageId: "1700000099999", timestamp: 1700000099999 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SLOW_UPLOAD_MS);
      // Exactly one `send` reached signal-cli: no false failure, no duplicate.
      expect(rpc.seen).toHaveLength(1);
      expect(rpc.seen[0]).toMatchObject({ method: "send", params: { message: "hello" } });
      const params = rpc.seen[0]?.params as { attachments?: string[] } | undefined;
      expect(params?.attachments).toHaveLength(1);
    } finally {
      await rpc.close();
    }
  }, 60_000);

  it("still fails a slow text-only send at the default deadline", async () => {
    const rpc = await slowUploadServer();
    try {
      await expect(rpc.send("hello", {})).rejects.toThrow(
        "Signal HTTP exceeded deadline after 10000ms",
      );
    } finally {
      await rpc.close();
    }
  }, 60_000);
});
