import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess extends EventEmitter {
  // PassThrough honors setEncoding("utf8") like real child pipes, so split
  // multibyte writes exercise the same decoder path as production ngrok.
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;
  closeOnKill = true;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    if (this.closeOnKill) {
      queueMicrotask(() => this.emit("close", null));
    }
    return true;
  }
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  setupTailscaleExposureRoutes: vi.fn(),
  cleanupTailscaleExposureRoute: vi.fn(),
}));

// mock-isolation: Replace the SDK spawn boundary without loading its process owners and workers.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  spawnOomScoreAdjusted: mocks.spawn,
}));

vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposureRoutes: mocks.setupTailscaleExposureRoutes,
  cleanupTailscaleExposureRoute: mocks.cleanupTailscaleExposureRoute,
}));

import { startTunnel } from "./tunnel.js";

async function requireTunnel(result: ReturnType<typeof startTunnel>) {
  const tunnel = await result;
  if (!tunnel) {
    throw new Error("Expected tunnel to start");
  }
  return tunnel;
}

function startNgrokTunnel(config: { port: number; path: string }) {
  return requireTunnel(startTunnel({ provider: "ngrok", ...config }));
}

function nextProcess(path = "/voice/webhook") {
  const proc = new FakeChildProcess();
  mocks.spawn.mockReturnValueOnce(proc as never);
  return { proc, result: startNgrokTunnel({ port: 3334, path }) };
}

function emitNgrokUrl(proc: FakeChildProcess, url: string): void {
  proc.stdout.write(`${JSON.stringify({ msg: "started tunnel", url })}\n`);
}

describe("voice-call tunnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(
      "https://host.tailnet.ts.net/voice/webhook",
    );
    mocks.cleanupTailscaleExposureRoute.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])("stops ngrok with alreadyClosed=%s", async (alreadyClosed) => {
    vi.useFakeTimers();
    const { proc, result } = nextProcess();
    proc.closeOnKill = false;
    emitNgrokUrl(proc, "https://stuck.ngrok.io");
    const tunnel = await result;
    if (alreadyClosed) {
      proc.emit("close", 0);
    }
    const stop = tunnel.stop();
    if (!alreadyClosed) {
      await vi.advanceTimersByTimeAsync(3_000);
    }
    await expect(stop).resolves.toBeUndefined();
    expect(proc.killedWith).toBe(alreadyClosed ? null : "SIGKILL");
  });

  it("unrefs startup and parses complete ngrok logs before bounding the incomplete tail", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const { proc, result } = nextProcess();
    expect(timeout.mock.results[0]?.value.hasRef()).toBe(false);
    proc.stdout.write(
      `${JSON.stringify({ msg: "started tunnel", url: "https://large.ngrok.io" })}\n${"x".repeat(20_000)}`,
    );

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://large.ngrok.io/voice/webhook");
  });

  it("preserves split ngrok errors across a UTF-16-safe bounded tail", async () => {
    const { proc, result } = nextProcess("/hook");
    const firstChunk = "🤖xERR_NG";

    // A raw marker-length tail starts on the low surrogate. Production must
    // discard that dangling half while retaining the split marker prefix.
    expect(firstChunk.slice(-8).charCodeAt(0)).toBe(0xdd16);
    proc.stderr.write(firstChunk);
    proc.stderr.write("ROK_108: invalid tunnel config");

    await expect(result).rejects.toThrow("ngrok error: xERR_NGROK_108: invalid tunnel config");
  });

  it.each([
    [
      "bounded tail",
      `ERR_NGROK discarded${"a".repeat(16_384)}`,
      `[output truncated]\n${"a".repeat(16_384)}`,
    ],
    [
      "surrogate boundary",
      `ERR_NGROK discarded🤖${"a".repeat(16_383)}`,
      `[output truncated]\n${"a".repeat(16_383)}`,
    ],
  ])("preserves the %s in ngrok startup errors", async (_name, input, diagnostic) => {
    const { proc, result } = nextProcess("/hook");
    const rejection = expect(result).rejects.toThrow(`ngrok error: ${diagnostic}`);
    proc.stderr.write(input);
    await rejection;
    expect(proc.killedWith).toBe("SIGKILL");
  });

  it("preserves UTF-8 across stderr pipe chunks", async () => {
    const message = "bad 😀 ERR_NGROK_3200: invalid token";
    const { proc, result } = nextProcess("/hook");
    const bytes = Buffer.from(message);
    const split = bytes.indexOf(Buffer.from("😀")) + 2;
    proc.stderr.write(bytes.subarray(0, split));
    proc.stderr.write(bytes.subarray(split));
    await expect(result).rejects.toThrow(`ngrok error: ${message}`);
  });

  it("routes Tailscale Funnel setup and cleanup through the shared exposure owner", async () => {
    const publicUrl = "https://host.tailnet.ts.net:8443/voice/webhook";
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(publicUrl);
    const tunnel = await requireTunnel(
      startTunnel({
        provider: "tailscale-funnel",
        port: 3334,
        path: "voice/webhook",
        tailscalePort: 8443,
        streamPaths: [{ publicPath: "voice/stream/realtime", localPath: "voice/stream/realtime" }],
      }),
    );

    expect(tunnel.publicUrl).toBe(publicUrl);
    expect(mocks.setupTailscaleExposureRoutes).toHaveBeenCalledWith({
      mode: "funnel",
      port: 8443,
      routes: [
        {
          path: "/voice/webhook",
          localUrl: "http://127.0.0.1:3334/voice/webhook",
        },
        {
          path: "/voice/stream/realtime",
          localUrl: "http://127.0.0.1:3334/voice/stream/realtime",
        },
      ],
    });

    await tunnel.stop();

    expect(mocks.cleanupTailscaleExposureRoute.mock.calls).toEqual([
      [{ mode: "funnel", port: 8443, path: "/voice/webhook" }],
      [{ mode: "funnel", port: 8443, path: "/voice/stream/realtime" }],
    ]);
  });

  it("rejects when the shared Tailscale exposure owner cannot mount the routes", async () => {
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(null);

    await expect(
      requireTunnel(startTunnel({ provider: "tailscale-funnel", port: 3334, path: "/hook" })),
    ).rejects.toThrow("Tailscale funnel failed");
  });

  it("does not create a tunnel when disabled", async () => {
    await expect(startTunnel({ provider: "none", port: 3334, path: "/hook" })).resolves.toBeNull();
  });

  it("rejects when ngrok stdout emits an error before the tunnel is ready", async () => {
    const { proc, result } = nextProcess("/hook");
    proc.stdout.emit("error", new Error("EPIPE"));
    await expect(result).rejects.toThrow("ngrok stdout error: EPIPE");
    expect(proc.killedWith).toBe("SIGKILL");
  });
});
