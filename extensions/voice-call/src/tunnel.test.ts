// Voice Call tests cover tunnel plugin behavior.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess extends EventEmitter {
  // PassThrough honors setEncoding("utf8") like real child pipes, so split
  // multibyte writes exercise the same decoder path as production ngrok.
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killedWith: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getTailscaleDnsName: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("./webhook/tailscale.js", () => ({
  getTailscaleDnsName: mocks.getTailscaleDnsName,
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: mocks.runCommand,
}));

import { startTunnel } from "./tunnel.js";

async function requireTunnel(result: ReturnType<typeof startTunnel>) {
  const tunnel = await result;
  if (!tunnel) {
    throw new Error("Expected tunnel to start");
  }
  return tunnel;
}

function startNgrokTunnel(config: {
  port: number;
  path: string;
  authToken?: string;
  domain?: string;
}) {
  return requireTunnel(
    startTunnel({
      provider: "ngrok",
      port: config.port,
      path: config.path,
      ngrokAuthToken: config.authToken,
      ngrokDomain: config.domain,
    }),
  );
}

function startTailscaleTunnel(config: { mode: "serve" | "funnel"; port: number; path: string }) {
  return requireTunnel(
    startTunnel({
      provider: config.mode === "serve" ? "tailscale-serve" : "tailscale-funnel",
      port: config.port,
      path: config.path,
    }),
  );
}

function nextProcess(): FakeChildProcess {
  const proc = new FakeChildProcess();
  mocks.spawn.mockReturnValueOnce(proc as never);
  return proc;
}

function emitNgrokUrl(proc: FakeChildProcess, url: string): void {
  proc.stdout.write(`${JSON.stringify({ msg: "started tunnel", url })}\n`);
}

function writeUtf8Chunks(stream: PassThrough, text: string, firstBytes: number): void {
  const bytes = Buffer.from(text, "utf8");
  stream.write(bytes.subarray(0, firstBytes));
  stream.write(bytes.subarray(firstBytes));
}

function commandResult(overrides: Record<string, unknown> = {}) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("voice-call tunnels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTailscaleDnsName.mockReset();
    mocks.runCommand.mockResolvedValue(commandResult());
  });

  it("starts ngrok and appends the webhook path to the public URL", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    emitNgrokUrl(proc, "https://abc.ngrok.io");

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://abc.ngrok.io/voice/webhook");
    expect(tunnel.provider).toBe("ngrok");
    expect(tunnel.stop).toBeTypeOf("function");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      ["http", "3334", "--log", "stdout", "--log-format", "json"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("parses complete ngrok log lines before bounding the incomplete tail", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

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
  });

  it("sets ngrok auth token before starting the tunnel", async () => {
    const tunnelProc = nextProcess();
    const result = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      authToken: "token",
    });

    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
    emitNgrokUrl(tunnelProc, "https://auth.ngrok.io");

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://auth.ngrok.io/hook");
    expect(tunnel.provider).toBe("ngrok");
    expect(mocks.runCommand).toHaveBeenCalledWith(
      ["ngrok", "config", "add-authtoken", "token"],
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("bounds ngrok command failure output", async () => {
    mocks.runCommand.mockResolvedValueOnce(
      commandResult({
        code: 1,
        stderr: `${"x".repeat(16_000)}-end`,
        stderrTruncatedBytes: 4_000,
      }),
    );
    const result = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      authToken: "token",
    });

    await expect(result).rejects.toThrow("[output truncated]");
    await expect(result).rejects.toThrow("-end");
  });

  it("rejects ngrok startup errors from stderr", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.stderr.write("ERR_NGROK_3200: invalid auth token");

    await expect(result).rejects.toThrow("ngrok error: ERR_NGROK_3200: invalid auth token");
  });

  it("preserves split ngrok errors across a UTF-16-safe bounded tail", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    const firstChunk = "🤖xERR_NG";

    // A raw marker-length tail starts on the low surrogate. Production must
    // discard that dangling half while retaining the split marker prefix.
    expect(firstChunk.slice(-8).charCodeAt(0)).toBe(0xdd16);
    proc.stderr.write(firstChunk);
    proc.stderr.write("ROK_108: invalid tunnel config");

    await expect(result).rejects.toThrow("ngrok error: xERR_NGROK_108: invalid tunnel config");
  });

  it("preserves UTF-8 split across ngrok stderr chunks in ERR_NGROK text", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    // Marker must not appear in the first decoded string, or startup rejects
    // before the held UTF-8 continuation bytes arrive.
    const message = "bad 😀 ERR_NGROK_3200: invalid token";
    const bytes = Buffer.from(message, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;

    expect(bytes[splitAt - 2]).toBe(0xf0);
    writeUtf8Chunks(proc.stderr, message, splitAt);

    await expect(result).rejects.toThrow(`ngrok error: ${message}`);
  });

  it("preserves UTF-8 split across ngrok stdout log chunks", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });
    // Keep URL ASCII; embed a real multibyte code point so the chunk cut is
    // inside UTF-8 (JSON.stringify would escape emoji to \\u sequences).
    const line = '{"msg":"started tunnel","url":"https://utf8.ngrok.io","info":"😀"}\n';
    const bytes = Buffer.from(line, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;

    expect(bytes[splitAt - 2]).toBe(0xf0);
    expect(bytes[splitAt]).toBe(0x98);
    writeUtf8Chunks(proc.stdout, line, splitAt);

    const tunnel = await result;
    expect(tunnel.publicUrl).toBe("https://utf8.ngrok.io/voice/webhook");
  });

  it("starts Tailscale serve using the resolved tailnet DNS name", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.tailnet.ts.net");
    const tunnel = await startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "voice/webhook",
    });

    expect(tunnel.publicUrl).toBe("https://host.tailnet.ts.net/voice/webhook");
    expect(tunnel.provider).toBe("tailscale-serve");
    expect(tunnel.stop).toBeTypeOf("function");
    expect(mocks.runCommand).toHaveBeenCalledWith(
      [
        "tailscale",
        "serve",
        "--bg",
        "--yes",
        "--set-path",
        "/voice/webhook",
        "http://127.0.0.1:3334/voice/webhook",
      ],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("drains and bounds Tailscale startup failure output", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.tailnet.ts.net");
    mocks.runCommand.mockResolvedValueOnce(
      commandResult({
        code: 1,
        stderr: `${"x".repeat(16_000)}-end`,
        stderrTruncatedBytes: 4_000,
      }),
    );
    const result = startTailscaleTunnel({
      mode: "funnel",
      port: 3334,
      path: "/voice/webhook",
    });

    await expect(result).rejects.toThrow("Tailscale funnel failed with code 1");
    await expect(result).rejects.toThrow("[output truncated]");
    await expect(result).rejects.toThrow("-end");
  });

  it("rejects Tailscale tunnel startup when the DNS name is unavailable", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue(null);

    await expect(
      startTailscaleTunnel({ mode: "funnel", port: 3334, path: "/hook" }),
    ).rejects.toThrow("Could not get Tailscale DNS name");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("dispatches tunnel providers from config", async () => {
    await expect(startTunnel({ provider: "none", port: 3334, path: "/hook" })).resolves.toBeNull();

    const proc = nextProcess();
    const result = startTunnel({ provider: "ngrok", port: 3334, path: "/hook" });
    emitNgrokUrl(proc, "https://dispatch.ngrok.io");

    const tunnel = await result;
    expect(tunnel?.publicUrl).toBe("https://dispatch.ngrok.io/hook");
    expect(tunnel?.provider).toBe("ngrok");
  });

  it("handles wrapper errors on tailscale stop cleanup without crashing", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.tailnet.ts.net");
    const tunnel = await startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "/voice/stop",
    });
    mocks.runCommand.mockRejectedValueOnce(new Error("tailscale not found"));

    await expect(tunnel.stop()).resolves.toBeUndefined();
  });

  it("rejects when ngrok stdout emits an error before the tunnel is ready", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    proc.stdout.emit("error", new Error("EPIPE"));
    await expect(result).rejects.toThrow("ngrok stdout error: EPIPE");
    expect(proc.killedWith).toBe("SIGKILL");
  });

  it("rejects when ngrok stderr emits an error before the tunnel is ready", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    proc.stderr.emit("error", new Error("EIO"));
    await expect(result).rejects.toThrow("ngrok stderr error: EIO");
    expect(proc.killedWith).toBe("SIGKILL");
  });

  it("preserves ngrok auth wrapper errors", async () => {
    mocks.runCommand.mockRejectedValueOnce(new Error("ngrok auth failed"));
    const result = startNgrokTunnel({ port: 3334, path: "/hook", authToken: "token" });
    await expect(result).rejects.toThrow("ngrok auth failed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stops immediately when the ngrok process already exited", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });
    emitNgrokUrl(proc, "https://early-exit.ngrok.io");
    const tunnel = await result;
    proc.emit("close", 0);
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(proc.killedWith).toBeNull();
  });
});
