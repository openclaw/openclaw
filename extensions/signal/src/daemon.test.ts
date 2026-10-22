import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSignalDaemonEndpointAvailable, spawnSignalDaemon } from "./daemon.js";

const spawnMock = vi.hoisted(() => vi.fn());
const ensurePortAvailableMock = vi.hoisted(() => vi.fn());
const subsystemWarnMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: (...args: unknown[]) => subsystemWarnMock(subsystem, ...args),
    }),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  ensurePortAvailableMock.mockImplementation(actual.ensurePortAvailable);
  return {
    ...actual,
    ensurePortAvailable: (...args: unknown[]) => ensurePortAvailableMock(...args),
  };
});

// mock-isolation: Keep process owners and worker runtimes out of this daemon fixture.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ spawnOomScoreAdjusted: spawnMock }));

function createMockChild() {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

let child: ReturnType<typeof createMockChild>;

function startDaemon(overrides: Partial<Parameters<typeof spawnSignalDaemon>[0]> = {}) {
  return spawnSignalDaemon({
    cliPath: "signal-cli",
    httpHost: "127.0.0.1",
    httpPort: 8080,
    ...overrides,
  });
}

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset().mockReturnValue(child);
  ensurePortAvailableMock.mockClear();
  subsystemWarnMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  child.stdout.end();
  child.stderr.end();
  child.removeAllListeners();
});

describe("spawnSignalDaemon", () => {
  it("starts the opt-in socket daemon without exposing an HTTP listener", () => {
    startDaemon({ socketPath: "/private/signal/rpc" });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--socket");
    expect(args).toContain("/private/signal/rpc");
    expect(args).not.toContain("--http");
    expect(args).not.toContain("--tcp");
    expect(args.slice(args.indexOf("--receive-mode"), args.indexOf("--receive-mode") + 2)).toEqual([
      "--receive-mode",
      "manual",
    ]);
  });
  it("rejects an occupied managed endpoint with actionable port guidance", async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener address");
    }

    try {
      await expect(
        assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: address.port }),
      ).rejects.toThrow(
        `Signal managed native endpoint 127.0.0.1:${address.port} is unavailable: Port ${address.port} is already in use. Stop the conflicting service, configure this Signal account with a different transport.httpPort, or use external-native for an intentionally operator-managed daemon.`,
      );
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
    // The released port is unowned; let the kernel choose this free probe.
    await expect(
      assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: 0 }),
    ).resolves.toBeUndefined();
  });

  it("defers non-collision bind failures to the operator-selected daemon", async () => {
    const bindError = Object.assign(new Error("bind EACCES 127.0.0.1:443"), { code: "EACCES" });
    ensurePortAvailableMock.mockRejectedValueOnce(bindError);
    await expect(
      assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: 443 }),
    ).resolves.toBeUndefined();
  });

  it("expands home-relative configPath before passing it to signal-cli", () => {
    startDaemon({ configPath: "~/.openclaw/signal-cli" });
    expect(spawnMock).toHaveBeenCalledWith(
      "signal-cli",
      [
        "--config",
        path.join(os.homedir(), ".openclaw/signal-cli"),
        "daemon",
        "--http",
        "127.0.0.1:8080",
        "--no-receive-stdout",
      ],
      { env: expect.any(Object), stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("starts signal-cli with process essentials but without Gateway secrets", () => {
    vi.stubEnv("JAVA_HOME", "/opt/java");
    vi.stubEnv("JAVA_OPTS", "-Xmx256m");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("XDG_DATA_HOME", "/srv/signal-test/share");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "synthetic-gateway-token");
    vi.stubEnv("OPENCLAW_HOOK_TOKEN", "synthetic-hook-token");
    vi.stubEnv("OP_CONNECT_TOKEN", "synthetic-connect-token");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-key");
    try {
      startDaemon();
      const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
      // PATH and HOME are kept too, but Windows hosts expose them under their own casing.
      expect(env).toMatchObject({
        JAVA_HOME: "/opt/java",
        JAVA_OPTS: "-Xmx256m",
        LC_ALL: "C.UTF-8",
        XDG_DATA_HOME: "/srv/signal-test/share",
      });
      expect(Object.values(env).join("\n")).not.toContain("synthetic-");
      expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
      expect(env).not.toHaveProperty("OPENCLAW_HOOK_TOKEN");
      expect(env).not.toHaveProperty("OP_CONNECT_TOKEN");
      expect(env).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the environment signal-cli reads for its own configuration", () => {
    vi.stubEnv("SIGNAL_CLI_CONFIG", "/srv/signal-test/config.json");
    vi.stubEnv("SIGNAL_CLI_USER_AGENT", "Signal-Android/9.0.0");
    try {
      startDaemon();
      const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
      expect(env).toMatchObject({
        SIGNAL_CLI_CONFIG: "/srv/signal-test/config.json",
        SIGNAL_CLI_USER_AGENT: "Signal-Android/9.0.0",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("matches Windows environment names case-insensitively", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) {
      throw new Error("process.platform descriptor is unavailable");
    }
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
    vi.stubEnv("LocalAppData", "C:\\Users\\signal\\AppData\\Local");
    vi.stubEnv("Openclaw_Hook_Token", "synthetic-hook-token");
    try {
      startDaemon();
      const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
      expect(env).toMatchObject({
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        LocalAppData: "C:\\Users\\signal\\AppData\\Local",
      });
      expect(env).not.toHaveProperty("Openclaw_Hook_Token");
    } finally {
      vi.unstubAllEnvs();
      Object.defineProperty(process, "platform", platform);
    }
  });

  describe("dropped proxy and CA environment notice", () => {
    const hintNames = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "all_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
    ];

    // The notice is once per process, so each case loads a fresh daemon module.
    async function loadFreshDaemon() {
      vi.resetModules();
      return (await import("./daemon.js")).spawnSignalDaemon;
    }

    beforeEach(() => {
      for (const name of hintNames) {
        vi.stubEnv(name, undefined);
      }
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("warns once, by name only, when proxy or CA variables are not passed through", async () => {
      vi.stubEnv(
        "HTTPS_PROXY",
        ["http://synthetic-user", "synthetic-pass@proxy.invalid:3128"].join(":"),
      );
      vi.stubEnv("no_proxy", "synthetic-internal.invalid");
      vi.stubEnv("SSL_CERT_FILE", "/srv/synthetic-ca/bundle.pem");
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "synthetic-gateway-token");
      const spawnFresh = await loadFreshDaemon();
      const startFresh = () =>
        spawnFresh({ cliPath: "signal-cli", httpHost: "127.0.0.1", httpPort: 8080 });

      startFresh();
      startFresh();

      expect(subsystemWarnMock).toHaveBeenCalledTimes(1);
      const [subsystem, message] = subsystemWarnMock.mock.calls[0] as [string, string];
      expect(subsystem).toBe("signal/daemon");
      expect(message).toContain("HTTPS_PROXY, SSL_CERT_FILE, no_proxy");
      expect(message).toContain("JAVA_TOOL_OPTIONS");
      expect(message).toContain("-Dhttps.proxyHost=<host> -Dhttps.proxyPort=<port>");
      expect(message).toContain("transport.cliPath");
      expect(message).toContain("external-native");
      expect(message).toContain(
        "https://docs.openclaw.ai/channels/signal#managed-daemon-environment",
      );
      expect(message).not.toContain("synthetic-");
      expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
      expect(env).not.toHaveProperty("HTTPS_PROXY");
      expect(env).not.toHaveProperty("SSL_CERT_FILE");
    });

    it("stays quiet when no proxy or CA variables are set", async () => {
      vi.stubEnv("HTTPS_PROXY", " ");
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "synthetic-gateway-token");
      const spawnFresh = await loadFreshDaemon();

      spawnFresh({ cliPath: "signal-cli", httpHost: "127.0.0.1", httpPort: 8080 });

      expect(subsystemWarnMock).not.toHaveBeenCalled();
    });
  });

  it("classifies complete UTF-8 output lines through the spawned process", async () => {
    const log = vi.fn();
    const error = vi.fn();
    startDaemon({ runtime: { log, error, exit: vi.fn() } });
    const ended = once(child.stderr, "end");
    child.stderr.write(Buffer.from("ER"));
    child.stderr.write(
      Buffer.from(
        "ROR DaemonCommand - startup failed\r\nSEVERE Manager - database exception\nWARN Manager - retrying\nreceive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed\npartial",
      ),
    );
    child.stderr.write(" warning\n");
    const utf8Line = Buffer.from("INFO Manager - café ready");
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    child.stderr.write(utf8Line.subarray(0, splitCodePointAt));
    child.stderr.end(utf8Line.subarray(splitCodePointAt));
    await ended;
    expect(error.mock.calls).toEqual([
      ["signal-cli: ERROR DaemonCommand - startup failed"],
      ["signal-cli: SEVERE Manager - database exception"],
    ]);
    expect(log.mock.calls).toEqual([
      ["signal-cli: WARN Manager - retrying"],
      [
        "signal-cli: receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      ],
      ["signal-cli: partial warning"],
      ["signal-cli: INFO Manager - café ready"],
    ]);
  });

  it("falls back to SIGKILL when the daemon does not exit after SIGTERM", async () => {
    vi.useFakeTimers();
    const handle = startDaemon();
    const stopPromise = handle.stop();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.runOnlyPendingTimersAsync();
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await stopPromise;
  });

  it("reuses the in-flight stop promise across repeated calls", async () => {
    const handle = startDaemon();
    const firstStop = handle.stop();
    const secondStop = handle.stop();
    expect(firstStop).toBe(secondStop);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
    await Promise.all([firstStop, secondStop]);
  });

  it("does not treat a post-spawn signaling error as process exit", async () => {
    const handle = startDaemon();
    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });
    child.emit("error", new Error("kill EPERM"));
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.emit("exit", 0, null);
    await stopPromise;
    expect(resolved).toBe(true);
  });
});
