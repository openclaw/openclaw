import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

/** Real child pipes preserve split UTF-8 through production's stateful decoder. */
function mockSpawnUtf8SplitChild(text: string): void {
  const bytes = Buffer.from(text, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;
  expect(bytes[splitAt - 2]).toBe(0xf0);
  const script = [
    `const bytes=Buffer.from(${JSON.stringify(text)},"utf8");`,
    `const split=${splitAt};`,
    "const stream=process.stderr;",
    "stream.write(bytes.subarray(0,split));",
    "setTimeout(()=>stream.write(bytes.subarray(split),()=>{}),40);",
  ].join("");
  mocks.spawn.mockImplementationOnce(() => {
    return spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
}

describe("voice-call tunnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(
      "https://host.tailnet.ts.net/voice/webhook",
    );
    mocks.cleanupTailscaleExposureRoute.mockResolvedValue(undefined);
  });

  it.each([false, true])("stops ngrok with alreadyClosed=%s", async (alreadyClosed) => {
    vi.useFakeTimers();
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("unrefs the ngrok startup timeout", async () => {
    const unrefSpy = vi.fn();
    const setTimeoutOriginal = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        const timer = Reflect.apply(setTimeoutOriginal, globalThis, [handler, timeout]);
        Object.defineProperty(timer, "unref", { value: unrefSpy, configurable: true });
        return timer;
      });
    try {
      const { proc, result } = nextProcess();
      emitNgrokUrl(proc, "https://unref.ngrok.io");

      await result;

      expect(unrefSpy).toHaveBeenCalledOnce();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("parses complete ngrok log lines before bounding the incomplete tail", async () => {
    const { proc, result } = nextProcess();

    proc.stdout.write(
      `${JSON.stringify({ msg: "started tunnel", url: "https://large.ngrok.io" })}\n${"x".repeat(20_000)}`,
    );

    const settled = await Promise.race([
      result.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 20);
      }),
    ]);
    expect(settled).toBe(true);

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://large.ngrok.io/voice/webhook");
    expect(tunnel.provider).toBe("ngrok");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      ["http", "3334", "--log", "stdout", "--log-format", "json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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

  it("preserves UTF-8 across real child stderr pipe chunks", async () => {
    const message = "bad 😀 ERR_NGROK_3200: invalid token";
    mockSpawnUtf8SplitChild(message);
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    await expect(result).rejects.toThrow(`ngrok error: ${message}`);
  });

  it("routes Tailscale Funnel setup and cleanup through the shared exposure owner", async () => {
    mocks.setupTailscaleExposureRoutes.mockResolvedValue(
      "https://host.tailnet.ts.net:8443/voice/webhook",
    );
    const tunnel = await requireTunnel(
      startTunnel({
        provider: "tailscale-funnel",
        port: 3334,
        path: "voice/webhook",
        tailscalePort: 8443,
        streamPaths: [
          {
            publicPath: "voice/stream/realtime",
            localPath: "voice/stream/realtime",
          },
        ],
      }),
    );

    expect(tunnel.publicUrl).toBe("https://host.tailnet.ts.net:8443/voice/webhook");
    expect(tunnel.provider).toBe("tailscale-funnel");
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
