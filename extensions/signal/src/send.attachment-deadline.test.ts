import { describe, expect, it, vi } from "vitest";
import { signalAccountConfig as accountConfig } from "./signal-rpc.test-support.js";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ path: "/tmp/image.png", contentType: "image/png" })),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
      resolveOutboundAttachmentFromUrlMock(...args),
  };
});

const { sendMessageSignal } = await import("./send.js");
const SIGNAL_TEST_CFG = accountConfig("external-native", "http://signal.test");
const recipient = "+155****4567";

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

  it("gives attachment sends an upload-aware deadline for the account cap", async () => {
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567894 });
    await send("", { mediaUrl: "/tmp/image.png", mediaLocalRoots: ["/tmp"] });
    // Default 8 MiB cap: 30s base + ceil(8388608 / 262144) * 1000ms = 62s.
    expect(sendOpts()).toMatchObject({ timeoutMs: 62_000 });
  });

  it("scales the attachment deadline with a raised media cap", async () => {
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567895 });
    await send("", {
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
      maxBytes: 41 * 1024 * 1024,
    });
    expect(sendOpts()).toMatchObject({ timeoutMs: 194_000 });
  });

  it("keeps an explicit caller timeout on attachment sends", async () => {
    signalRpcRequestMock.mockReset().mockResolvedValueOnce({ timestamp: 1234567896 });
    await send("", {
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
      timeoutMs: 1_500,
    });
    expect(sendOpts()).toMatchObject({ timeoutMs: 1_500 });
  });
});

describe("Signal attachment send deadline over real HTTP RPC", () => {
  // signal-cli answers `send` only after the upload finishes, so a slow upload
  // looks like an idle request. The 10s default aborted these; #195284 reports
  // a 41 MB PDF reported failed yet delivered ~30s later.
  const SLOW_UPLOAD_MS = 12_000;

  async function slowUploadServer() {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "signal-send-deadline-"));
    const mediaPath = join(dir, "large.pdf");
    await writeFile(mediaPath, Buffer.alloc(41 * 1024 * 1024, 0x20));
    // `await using` would dispose right after the awaited expression resolves,
    // so the server must outlive the send; the caller closes it explicitly.
    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { signalJsonServer: createRpcServer, listenSignalServer } =
      await import("./signal-rpc.test-support.js");
    const server = createRpcServer((payload, _request, response) => {
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
      send: (text: string, options: Record<string, unknown>) =>
        sendReal(recipient, text, { cfg: cfg as never, ...options } as never),
      close: () => server.close(),
    };
  }

  it("delivers a 41 MB attachment whose upload outlasts the old 10s deadline", async () => {
    const rpc = await slowUploadServer();
    try {
      const startedAt = Date.now();
      await expect(
        rpc.send("hello", {
          mediaUrl: rpc.mediaPath,
          mediaLocalRoots: [rpc.dir],
          maxBytes: 60 * 1024 * 1024,
        }),
      ).resolves.toMatchObject({ messageId: "1700000099999", timestamp: 1700000099999 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SLOW_UPLOAD_MS);
    } finally {
      rpc.close();
    }
  }, 60_000);

  it("still fails a slow text-only send at the default deadline", async () => {
    const rpc = await slowUploadServer();
    try {
      await expect(rpc.send("hello", {})).rejects.toThrow(
        "Signal HTTP exceeded deadline after 10000ms",
      );
    } finally {
      rpc.close();
    }
  }, 60_000);
});
