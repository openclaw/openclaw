import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake child process that acts like a real ChildProcess for our tests.
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private _killed = false;
  killedWith: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this._killed = true;
    this.killedWith = signal;
    // Simulate the process closing after being killed.
    // Use setImmediate so synchronous code after kill() runs first.
    setImmediate(() => this.emit("close", null));
    return true;
  }

  get killed(): boolean {
    return this._killed;
  }

  /** Helper: emit a chunk on stdout as if the process wrote it. */
  writeStdout(data: string): void {
    this.stdout.emit("data", Buffer.from(data));
  }

  /** Helper: emit a chunk on stderr. */
  writeStderr(data: string): void {
    this.stderr.emit("data", Buffer.from(data));
  }

  /** Helper: close the process with a given exit code. */
  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  /** Helper: emit a process-level error. */
  fail(err: Error): void {
    this.emit("error", err);
  }
}

// ---------------------------------------------------------------------------
// Module-level mock: intercept all spawn() calls.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getTailscaleDnsName: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("./webhook/tailscale.js", () => ({
  getTailscaleDnsName: mocks.getTailscaleDnsName,
}));

// Import AFTER mocks are set up.
import { isNgrokAvailable, startNgrokTunnel, startTailscaleTunnel, startTunnel } from "./tunnel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a FakeChildProcess and register it as the next spawn() return value. */
function makeProc(): FakeChildProcess {
  const proc = new FakeChildProcess();
  mocks.spawn.mockReturnValueOnce(proc as never);
  return proc;
}

/** Emit a JSON ngrok log line on a process's stdout. */
function emitNgrokLog(proc: FakeChildProcess, payload: object): void {
  proc.writeStdout(JSON.stringify(payload) + "\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isNgrokAvailable()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when ngrok exits with code 0", async () => {
    const proc = makeProc();
    const resultPromise = isNgrokAvailable();
    proc.close(0);
    await expect(resultPromise).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith("ngrok", ["version"], expect.any(Object));
  });

  it("returns false when ngrok exits with a non-zero code", async () => {
    const proc = makeProc();
    const resultPromise = isNgrokAvailable();
    proc.close(1);
    await expect(resultPromise).resolves.toBe(false);
  });

  it("returns false when spawn emits an ENOENT error (binary not installed)", async () => {
    const proc = makeProc();
    const resultPromise = isNgrokAvailable();
    proc.fail(Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" }));
    await expect(resultPromise).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("startNgrokTunnel() — happy paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves with publicUrl when stdout emits a 'started tunnel' log", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/voice/webhook" });

    emitNgrokLog(proc, { msg: "started tunnel", url: "https://abc123.ngrok.io" });

    const result = await tunnelPromise;
    expect(result.publicUrl).toBe("https://abc123.ngrok.io/voice/webhook");
    expect(result.provider).toBe("ngrok");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      expect.arrayContaining(["http", "3334"]),
      expect.any(Object),
    );
  });

  it("resolves with publicUrl via the fallback addr+url path", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/v/hook" });

    // The primary msg check won't fire — only the addr fallback will.
    emitNgrokLog(proc, { addr: "localhost:3334", url: "https://fallback.ngrok.io" });

    const result = await tunnelPromise;
    expect(result.publicUrl).toBe("https://fallback.ngrok.io/v/hook");
  });

  it("appends the path suffix correctly to the public URL", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 1234, path: "/custom/path" });

    emitNgrokLog(proc, { msg: "started tunnel", url: "https://xyz.ngrok.io" });

    const { publicUrl } = await tunnelPromise;
    expect(publicUrl).toBe("https://xyz.ngrok.io/custom/path");
  });

  it("handles multi-line stdout chunks correctly (splits on newlines)", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    // Write two log lines in a single chunk to make sure line-splitting works.
    const line1 = JSON.stringify({ msg: "starting ngrok", level: "info" });
    const line2 = JSON.stringify({ msg: "started tunnel", url: "https://multi.ngrok.io" });
    proc.writeStdout(line1 + "\n" + line2 + "\n");

    const { publicUrl } = await tunnelPromise;
    expect(publicUrl).toBe("https://multi.ngrok.io/hook");
  });
});

// ---------------------------------------------------------------------------

describe("startNgrokTunnel() — error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects after the 30s startup timeout", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    const assertPromise = expect(tunnelPromise).rejects.toThrow("ngrok startup timed out (30s)");

    // The setTimeout in startNgrokTunnel is registered synchronously after spawn(),
    // so advancing timers immediately is safe here.
    await vi.runAllTimersAsync();

    await assertPromise;
    expect(proc.killed).toBe(true);
    expect(proc.killedWith).toBe("SIGTERM");
  });

  it("rejects when stderr contains ERR_NGROK", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.writeStderr("ERR_NGROK_3200: invalid auth token");

    await expect(tunnelPromise).rejects.toThrow("ngrok error:");
  });

  it("rejects when the ngrok process exits unexpectedly with non-zero code", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.close(1);

    await expect(tunnelPromise).rejects.toThrow("ngrok exited unexpectedly with code 1");
  });

  it("rejects when spawn itself emits an error", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    proc.fail(Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" }));

    await expect(tunnelPromise).rejects.toThrow("Failed to start ngrok: spawn ngrok ENOENT");
  });
});

// ---------------------------------------------------------------------------

describe("startNgrokTunnel() — stop()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends SIGTERM and waits for close when stop() is called", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({ port: 3334, path: "/hook" });

    emitNgrokLog(proc, { msg: "started tunnel", url: "https://stop.ngrok.io" });

    const result = await tunnelPromise;

    const stopPromise = result.stop();
    // The FakeChildProcess.kill() emits 'close' via setImmediate, so we await stop().
    await stopPromise;

    expect(proc.killed).toBe(true);
    expect(proc.killedWith).toBe("SIGTERM");
  });
});

// ---------------------------------------------------------------------------

describe("startNgrokTunnel() — auth token and domain flags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls 'ngrok config add-authtoken' before starting the tunnel when authToken is provided", async () => {
    // First spawn: the `ngrok config add-authtoken` command.
    const configProc = makeProc();
    // Second spawn: the actual `ngrok http` tunnel.
    const tunnelProc = makeProc();

    const tunnelPromise = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      authToken: "my-secret-token",
    });

    // Resolve the config command first.
    configProc.close(0);

    // Wait for the async function to proceed to the next spawn.
    while (mocks.spawn.mock.calls.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Then emit the tunnel URL.
    emitNgrokLog(tunnelProc, { msg: "started tunnel", url: "https://auth.ngrok.io" });

    await tunnelPromise;

    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      "ngrok",
      ["config", "add-authtoken", "my-secret-token"],
      expect.any(Object),
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      "ngrok",
      expect.arrayContaining(["http", "3334"]),
      expect.any(Object),
    );
  });

  it("passes --domain flag to ngrok when domain is provided", async () => {
    const proc = makeProc();
    const tunnelPromise = startNgrokTunnel({
      port: 3334,
      path: "/hook",
      domain: "my-custom.ngrok.io",
    });

    emitNgrokLog(proc, { msg: "started tunnel", url: "https://my-custom.ngrok.io" });

    await tunnelPromise;

    expect(mocks.spawn).toHaveBeenCalledWith(
      "ngrok",
      expect.arrayContaining(["--domain", "my-custom.ngrok.io"]),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------

describe("startTailscaleTunnel()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with public URL when tailscale serve exits with code 0", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("my-machine.tailnet.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "/voice/webhook",
    });

    await Promise.resolve();
    proc.close(0);

    const result = await tunnelPromise;
    expect(result.publicUrl).toBe("https://my-machine.tailnet.ts.net/voice/webhook");
    expect(result.provider).toBe("tailscale-serve");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["serve", "--bg", "--yes"]),
      expect.any(Object),
    );
  });

  it("resolves with public URL when tailscale funnel exits with code 0", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("my-machine.tailnet.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTailscaleTunnel({
      mode: "funnel",
      port: 3334,
      path: "/hook",
    });

    await Promise.resolve();
    proc.close(0);

    const result = await tunnelPromise;
    expect(result.publicUrl).toBe("https://my-machine.tailnet.ts.net/hook");
    expect(result.provider).toBe("tailscale-funnel");
  });

  it("prepends a leading slash to path if missing", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "no-leading-slash",
    });

    await Promise.resolve();
    proc.close(0);

    const result = await tunnelPromise;
    expect(result.publicUrl).toBe("https://host.ts.net/no-leading-slash");
  });

  it("rejects when getTailscaleDnsName returns null", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue(null);

    await expect(
      startTailscaleTunnel({ mode: "serve", port: 3334, path: "/hook" }),
    ).rejects.toThrow("Could not get Tailscale DNS name");

    // spawn should NOT have been called.
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects after the 10s timeout", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "/hook",
    });

    // getTailscaleDnsName is async — we must flush the microtask queue first
    // so that the spawn() and its setTimeout are registered before we advance time.
    await Promise.resolve();

    const assertPromise = expect(tunnelPromise).rejects.toThrow("Tailscale serve timed out");
    await vi.runAllTimersAsync();

    await assertPromise;
    expect(proc.killed).toBe(true);
  });

  it("rejects when tailscale exits with a non-zero code", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("host.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTailscaleTunnel({
      mode: "serve",
      port: 3334,
      path: "/hook",
    });

    await Promise.resolve();
    proc.close(1);

    await expect(tunnelPromise).rejects.toThrow("Tailscale serve failed with code 1");
  });
});

// ---------------------------------------------------------------------------

describe("startTunnel() — dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for provider 'none'", async () => {
    const result = await startTunnel({
      provider: "none",
      port: 3334,
      path: "/hook",
    });
    expect(result).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("routes 'ngrok' to startNgrokTunnel", async () => {
    const proc = makeProc();
    const tunnelPromise = startTunnel({
      provider: "ngrok",
      port: 3334,
      path: "/hook",
      ngrokAuthToken: undefined,
      ngrokDomain: undefined,
    });

    emitNgrokLog(proc, { msg: "started tunnel", url: "https://dispatch.ngrok.io" });

    const result = await tunnelPromise;
    expect(result).not.toBeNull();
    expect(result?.provider).toBe("ngrok");
    expect(result?.publicUrl).toBe("https://dispatch.ngrok.io/hook");
  });

  it("routes 'tailscale-serve' to startTailscaleTunnel with mode serve", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("ts-host.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTunnel({
      provider: "tailscale-serve",
      port: 3334,
      path: "/hook",
    });

    await Promise.resolve();
    proc.close(0);

    const result = await tunnelPromise;
    expect(result?.provider).toBe("tailscale-serve");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["serve"]),
      expect.any(Object),
    );
  });

  it("routes 'tailscale-funnel' to startTailscaleTunnel with mode funnel", async () => {
    mocks.getTailscaleDnsName.mockResolvedValue("ts-host.ts.net");
    const proc = makeProc();

    const tunnelPromise = startTunnel({
      provider: "tailscale-funnel",
      port: 3334,
      path: "/hook",
    });

    await Promise.resolve();
    proc.close(0);

    const result = await tunnelPromise;
    expect(result?.provider).toBe("tailscale-funnel");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "tailscale",
      expect.arrayContaining(["funnel"]),
      expect.any(Object),
    );
  });
});
