// Voice Call tests cover tunnel plugin behavior.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
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
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ msg: "started tunnel", url })}\n`));
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

    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ msg: "started tunnel", url: "https://large.ngrok.io" })}\n${"x".repeat(20_000)}`,
      ),
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

    proc.stderr.emit("data", Buffer.from("ERR_NGROK_3200: invalid auth token"));

    await expect(result).rejects.toThrow("ngrok error:");
  });

  it("detects ERR_NGROK marker split across stderr chunks", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    // Emit the ERR_NGROK marker split across two chunks
    proc.stderr.emit("data", Buffer.from("ERR_NG"));
    proc.stderr.emit("data", Buffer.from("ROK_108: invalid tunnel config"));

    await expect(result).rejects.toThrow("ngrok error:");
    await expect(result).rejects.toThrow("ERR_NGROK_108");
  });

  it("detects ERR_NGROK in a large combined tail that exceeds the retention window", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    // First chunk has the marker prefix only
    proc.stderr.emit("data", Buffer.from("ERR_NG"));
    // Second chunk completes the marker then adds noise so the combined
    // length exceeds the 512-byte retention window.  Classify-before-truncate
    // must detect the completed marker before the tail is sliced.
    const tail = "ROK_108: invalid tunnel config " + "x".repeat(800);
    proc.stderr.emit("data", Buffer.from(tail));

    await expect(result).rejects.toThrow("ngrok error:");
    await expect(result).rejects.toThrow("ERR_NGROK_108");
  });

  it("rejects with generic exit when non-ERR_NGROK stderr is split across chunks", async () => {
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    // Non-bind error split across chunks — must NOT match ERR_NGROK
    proc.stderr.emit("data", Buffer.from("some erro"));
    proc.stderr.emit("data", Buffer.from("r message"));

    // Close with non-zero code — should get generic exit, not ngrok error
    proc.close(1);

    await expect(result).rejects.toThrow("ngrok exited unexpectedly with code 1");
    await expect(result).rejects.not.toThrow("ngrok error:");
  });

  it("detects ERR_NGROK when final fragment arrives after stdout close but before stderr close", async () => {
    // Node can deliver the final stderr chunk between 'close' events on
    // different streams.  The combined-tail check must still fire.
    const proc = nextProcess();
    const result = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.stderr.emit("data", Buffer.from("ERR_NG"));
    // stdout "closes" first (in real ngrok the TCP connection may half-close)
    proc.stdout.emit("close");
    // stderr final fragment arrives
    proc.stderr.emit("data", Buffer.from("ROK_108: invalid tunnel config"));

    await expect(result).rejects.toThrow("ngrok error:");
    await expect(result).rejects.toThrow("ERR_NGROK_108");
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
