import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
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

function daemonEnvironment(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
  startDaemon();
  return spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
}

async function freshDaemonEnvironment(values: Record<string, string> = {}) {
  for (const name of (
    "HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY http_proxy https_proxy no_proxy all_proxy " +
    "SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE NODE_EXTRA_CA_CERTS"
  ).split(" ")) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
  // The notice is once per process; each case needs a fresh module.
  vi.resetModules();
  const { spawnSignalDaemon: spawnFresh } = await import("./daemon.js");
  return () => spawnFresh({ cliPath: "signal-cli", httpHost: "127.0.0.1", httpPort: 8080 });
}

beforeEach(() => {
  child = createMockChild();
  spawnMock.mockReset().mockReturnValue(child);
  ensurePortAvailableMock.mockClear();
  subsystemWarnMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
    const port = await listenOnLoopback(listener);

    try {
      await expect(
        assertSignalDaemonEndpointAvailable({ httpHost: "127.0.0.1", httpPort: port }),
      ).rejects.toThrow(
        `Signal managed native endpoint 127.0.0.1:${port} is unavailable: Port ${port} is already in use. Stop the conflicting service, configure this Signal account with a different transport.httpPort, or use external-native for an intentionally operator-managed daemon.`,
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
    expect(spawnMock.mock.calls[0]?.[1].slice(0, 2)).toEqual([
      "--config",
      path.join(os.homedir(), ".openclaw/signal-cli"),
    ]);
  });

  it("starts signal-cli with process essentials but without Gateway secrets", () => {
    const essentials = {
      JAVA_HOME: "/opt/java",
      JAVA_OPTS: "-Xmx256m",
      LC_ALL: "C.UTF-8",
      XDG_DATA_HOME: "/srv/signal-test/share",
      SIGNAL_CLI_CONFIG: "/srv/signal-test/config.json",
      SIGNAL_CLI_USER_AGENT: "Signal-Android/9.0.0",
    };
    const secrets = {
      OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
      OPENCLAW_HOOK_TOKEN: "synthetic-hook-token",
      OP_CONNECT_TOKEN: "synthetic-connect-token",
      OPENAI_API_KEY: "synthetic-provider-key",
    };
    const env = daemonEnvironment({ ...essentials, ...secrets });
    expect(env).toMatchObject(essentials);
    expect(Object.values(env).join("\n")).not.toContain("synthetic-");
    for (const name of Object.keys(secrets)) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("matches Windows environment names case-insensitively", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) {
      throw new Error("process.platform descriptor is unavailable");
    }
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const essentials = {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      LocalAppData: "C:\\Users\\signal\\AppData\\Local",
    };
    try {
      const env = daemonEnvironment({ ...essentials, Openclaw_Hook_Token: "synthetic-hook-token" });
      expect(env).toMatchObject(essentials);
      expect(env).not.toHaveProperty("Openclaw_Hook_Token");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("warns once, by name only, when proxy or CA variables are not passed through", async () => {
    const startFresh = await freshDaemonEnvironment({
      HTTPS_PROXY: "http://synthetic-user:synthetic-pass@proxy.invalid:3128",
      no_proxy: "synthetic-internal.invalid",
      SSL_CERT_FILE: "/srv/synthetic-ca/bundle.pem",
      OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
    });
    startFresh();
    startFresh();

    expect(subsystemWarnMock).toHaveBeenCalledTimes(1);
    const [subsystem, message] = subsystemWarnMock.mock.calls[0] as [string, string];
    expect(subsystem).toBe("signal/daemon");
    expect(message).toContain("HTTPS_PROXY, SSL_CERT_FILE, no_proxy");
    expect(message).not.toContain("synthetic-");
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(env).not.toHaveProperty("SSL_CERT_FILE");
  });

  it("stays quiet when no proxy or CA variables are set", async () => {
    const startFresh = await freshDaemonEnvironment({
      HTTPS_PROXY: " ",
      OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token",
    });
    startFresh();
    expect(subsystemWarnMock).not.toHaveBeenCalled();
  });

  it("classifies complete UTF-8 output lines through the spawned process", async () => {
    const errors = [
      "ERROR DaemonCommand - startup failed",
      "SEVERE Manager - database exception",
    ] as const;
    const logs = [
      "WARN Manager - retrying",
      "receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      "partial warning",
      "INFO Manager - café ready",
    ] as const;
    const log = vi.fn();
    const error = vi.fn();
    startDaemon({ runtime: { log, error, exit: vi.fn() } });
    const ended = once(child.stderr, "end");
    child.stderr.write("ER");
    child.stderr.write(
      `${errors[0].slice(2)}\r\n${errors[1]}\n${logs.slice(0, 2).join("\n")}\npartial`,
    );
    child.stderr.write(" warning\n");
    const utf8Line = Buffer.from(logs[3]);
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    child.stderr.write(utf8Line.subarray(0, splitCodePointAt));
    child.stderr.end(utf8Line.subarray(splitCodePointAt));
    await ended;
    expect(error.mock.calls).toEqual(errors.map((line) => [`signal-cli: ${line}`]));
    expect(log.mock.calls).toEqual(logs.map((line) => [`signal-cli: ${line}`]));
  });

  it.each(["forced", "repeated", "signaling-error"])(
    "waits for actual exit: %s stop",
    async (mode) => {
      vi.useFakeTimers();
      const handle = startDaemon();
      let resolved = false;
      const stopPromise = handle.stop();
      const settled = stopPromise.then(() => {
        resolved = true;
      });
      if (mode === "forced") {
        expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
        await vi.runOnlyPendingTimersAsync();
        expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      } else if (mode === "repeated") {
        expect(handle.stop()).toBe(stopPromise);
        expect(child.kill).toHaveBeenCalledTimes(1);
      } else {
        child.emit("error", new Error("kill EPERM"));
        await Promise.resolve();
        expect(resolved).toBe(false);
      }
      child.emit("exit", mode === "forced" ? null : 0, mode === "forced" ? "SIGKILL" : null);
      await settled;
      expect(resolved).toBe(true);
    },
  );
});
