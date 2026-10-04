import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Agent, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const execFileSync = (...args: unknown[]) => {
    const mock = execFileSyncMock.getMockImplementation();
    return mock
      ? mock(...args)
      : (actual.execFileSync as unknown as (...actualArgs: unknown[]) => unknown)(...args);
  };
  return {
    ...actual,
    default: { ...actual, execFileSync },
    execFileSync,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

const { registerManagedProxyBrowserCdpBypassMock } = vi.hoisted(() => ({
  registerManagedProxyBrowserCdpBypassMock: vi.fn<(url: string) => (() => void) | undefined>(
    () => undefined,
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime-internal", () => ({
  registerManagedProxyBrowserCdpBypass: registerManagedProxyBrowserCdpBypassMock,
}));

const ensurePortAvailableMock = vi.hoisted(() =>
  vi.fn<(port: number, host?: string) => Promise<void>>(async () => {}),
);

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>()),
  ensurePortAvailable: ensurePortAvailableMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => "/tmp/openclaw-browser-test",
}));

// Shrink long launch/bootstrap timeouts so tests don't wait 15s for
// the CHROME_LAUNCH_READY_WINDOW_MS elapse-on-failure path.
vi.mock("./cdp-timeouts.js", async () => {
  const actual = await vi.importActual<typeof import("./cdp-timeouts.js")>("./cdp-timeouts.js");
  return {
    ...actual,
    CHROME_LAUNCH_READY_WINDOW_MS: 20,
    CHROME_LAUNCH_READY_POLL_MS: 5,
    CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS: 120,
    CHROME_BOOTSTRAP_PREFS_POLL_MS: 5,
    CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS: 40,
    CHROME_BOOTSTRAP_EXIT_POLL_MS: 5,
  };
});

import { CHROME_STDERR_HINT_MAX_CHARS } from "./cdp-timeouts.js";
import {
  inspectLocalChromeHeadlessMode,
  isChromeCdpReady,
  launchOpenClawChrome,
  ManagedChromeCleanupError,
  resolveOpenClawUserDataDir,
  stopOwnedOpenClawChrome,
} from "./chrome.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const CHROME_TEST_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

type FakeProc = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (sig?: string) => boolean;
  stderr: EventEmitter;
};

function makeFakeProc(overrides: Partial<FakeProc> = {}): FakeProc {
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((sig = "SIGTERM") => {
      proc.killed = true;
      proc.signalCode = sig as NodeJS.Signals;
      proc.emit("exit", null, sig);
      return true;
    }),
    stderr,
  }) as unknown as FakeProc;
  return Object.assign(proc, overrides);
}

function makeFailedSpawnProc(error: NodeJS.ErrnoException): FakeProc {
  const proc = makeFakeProc({ pid: undefined });
  queueMicrotask(() => proc.emit("error", error));
  return proc;
}

function stubBrowserExecutableAndPrefs(
  preferences: "present" | "missing",
  executablePath?: string,
) {
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    const value = String(p);
    const isExecutable = executablePath
      ? value === executablePath
      : value.includes("Google Chrome") ||
        value.includes("google-chrome") ||
        value.includes("/usr/bin/chromium");
    const isPreferences = value.endsWith("Local State") || value.endsWith("Preferences");
    return isExecutable || (preferences === "present" && isPreferences);
  });
}

function requireSpawnCall(index = 0): unknown[] {
  const call = spawnMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected spawn call #${index + 1}`);
  }
  return call;
}

function requireSpawnOptions(index = 0): { env?: NodeJS.ProcessEnv } {
  const options = requireSpawnCall(index)[2];
  if (!options || typeof options !== "object") {
    throw new Error(`expected spawn options for call #${index + 1}`);
  }
  return options as { env?: NodeJS.ProcessEnv };
}

function mockExpiredLaunchPollingClock(): void {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => {
    now += 1_000;
    return now;
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function startLinuxZombieProcess(): { ready: Promise<number>; reap: () => Promise<void> } {
  const parent = execFile("python3", [
    "-c",
    [
      "import os, sys",
      "pid = os.fork()",
      "if pid == 0:",
      "    os._exit(0)",
      // Observe exit without reaping: the published PID stays a zombie until stdin closes.
      "os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)",
      "print(pid, flush=True)",
      "sys.stdin.readline()",
      "os.waitpid(pid, 0)",
    ].join("\n"),
  ]);
  const closed = once(parent, "close");
  const ready = new Promise<number>((resolve) => {
    parent.stdout?.once("data", (chunk) => {
      resolve(Number.parseInt(String(chunk).trim(), 10));
    });
  });
  return {
    ready: awaitGateBeforeSettlement(ready, closed, "child did not enter zombie state"),
    reap: async () => {
      parent.stdin?.end();
      await closed;
    },
  };
}

function linuxProcStatLine(pid: number, startTime: string): string {
  return `${pid} (chrome) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0`;
}

function linuxTcpTableForPort(port: number, inode: string): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    `   0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`,
  ].join("\n");
}

function mockLinuxManagedChromeOwnership(params: {
  pid: number;
  port: number;
  executablePath: string;
  userDataDir: string;
  argvExecutablePath?: string;
  ownsPort?: boolean;
  extraArgs?: string[];
}) {
  const ownsPort = params.ownsPort ?? true;
  const inode = "889001";
  const argv = [
    params.argvExecutablePath ?? params.executablePath,
    `--remote-debugging-port=${params.port}`,
    `--user-data-dir=${params.userDataDir}`,
    ...(params.extraArgs ?? []),
  ];
  const readFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(
    (filePath, options?: BufferEncoding | fs.ReadFileSyncOptions | null) => {
      const s = String(filePath);
      if (s === `/proc/${params.pid}/cmdline`) {
        return Buffer.from(`${argv.join("\0")}\0`);
      }
      if (s === `/proc/${params.pid}/stat`) {
        return linuxProcStatLine(params.pid, "1234567");
      }
      if (s === "/proc/net/tcp") {
        return ownsPort ? linuxTcpTableForPort(params.port, inode) : linuxTcpTableForPort(1, inode);
      }
      if (s === "/proc/net/tcp6") {
        return "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
      }
      return readFileSync(
        filePath,
        typeof options === "string" ? { encoding: options } : (options ?? {}),
      );
    },
  );

  const readdirSync = fs.readdirSync.bind(fs);
  vi.spyOn(fs, "readdirSync").mockImplementation(((dirPath, options) => {
    if (String(dirPath) === `/proc/${params.pid}/fd`) {
      return ownsPort ? (["7"] as never) : ([] as never);
    }
    return readdirSync(dirPath, options as never);
  }) as typeof fs.readdirSync);

  const readlinkSync = fs.readlinkSync.bind(fs);
  vi.spyOn(fs, "readlinkSync").mockImplementation(((linkPath, options) => {
    if (String(linkPath) === `/proc/${params.pid}/fd/7`) {
      return `socket:[${inode}]`;
    }
    return readlinkSync(linkPath, options as never);
  }) as typeof fs.readlinkSync);
}

async function withMockChromeCdpServer(params: {
  wsPath: string;
  onConnection?: (wss: WebSocketServer) => void;
  onCommand?: (method: string) => unknown;
  run: (baseUrl: string) => Promise<void>;
}) {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}${params.wsPath}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHROME_TEST_WS_MAX_PAYLOAD_BYTES });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== params.wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  if (params.onConnection) {
    params.onConnection(wss);
  } else {
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as {
          id?: unknown;
          method?: unknown;
        };
        if (typeof message.id === "number" && typeof message.method === "string") {
          const result = params.onCommand
            ? params.onCommand(message.method)
            : message.method === "Browser.getVersion"
              ? { product: "Chrome/Mock", userAgent: "OpenClawTest" }
              : undefined;
          if (result !== undefined) {
            ws.send(JSON.stringify({ id: message.id, result }));
          }
        }
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const addr = server.address() as AddressInfo;
    await params.run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

describe("chrome.ts internal", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (!fs.existsSync(candidate)) {
        throw new Error("ENOENT");
      }
      return { isFile: () => true } as fs.Stats;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    ensurePortAvailableMock.mockReset();
    ensurePortAvailableMock.mockImplementation(async () => {});
    registerManagedProxyBrowserCdpBypassMock.mockReset();
    registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => undefined);
  });

  it.each([
    { name: "headed Chrome", extraArgs: [], ownsPort: true, loopback: true, expected: false },
    {
      name: "headless Chrome",
      extraArgs: ["--headless=new"],
      ownsPort: true,
      loopback: true,
      expected: true,
    },
    { name: "a local relay", extraArgs: [], ownsPort: false, loopback: true, expected: undefined },
    {
      name: "a remote browser",
      extraArgs: [],
      ownsPort: true,
      loopback: false,
      expected: undefined,
    },
  ])("inspects $name only after proving local process ownership", async (testCase) => {
    const originalPlatform = process.platform;
    const browserPid = 43210;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/EXTERNAL_MODE",
        onCommand: (method) => {
          expect(method).toBe("SystemInfo.getProcessInfo");
          return { processInfo: [{ type: "browser", id: browserPid }] };
        },
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          mockLinuxManagedChromeOwnership({
            pid: browserPid,
            port,
            executablePath: "/usr/bin/chromium",
            userDataDir: "/tmp/external-browser",
            ownsPort: testCase.ownsPort,
            extraArgs: testCase.extraArgs,
          });
          const profile = {
            name: "manual-cdp",
            cdpUrl: baseUrl,
            cdpHost: "127.0.0.1",
            cdpIsLoopback: testCase.loopback,
            cdpPort: port,
            color: "#00AA00",
            driver: "openclaw",
            headless: false,
            attachOnly: true,
          } as ResolvedBrowserProfile;
          await expect(
            inspectLocalChromeHeadlessMode({
              profile,
              browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/EXTERNAL_MODE`,
              timeoutMs: 100,
            }),
          ).resolves.toBe(testCase.expected);
        },
      });
      if (testCase.loopback) {
        expect(killSpy).toHaveBeenCalledWith(browserPid, 0);
      } else {
        expect(killSpy).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  describe("launchOpenClawChrome", () => {
    let tmpDir = "";

    beforeEach(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-launch-"));
    });

    afterEach(async () => {
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    const makeProfile = (
      cdpPort: number,
      overrides: Partial<ResolvedBrowserProfile> = {},
    ): ResolvedBrowserProfile =>
      ({
        name: path.basename(tmpDir),
        color: "#FF4500",
        cdpPort,
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        ...overrides,
      }) as unknown as ResolvedBrowserProfile;

    const makeResolved = (overrides: Partial<ResolvedBrowserConfig> = {}): ResolvedBrowserConfig =>
      ({
        headless: true,
        noSandbox: true,
        extraArgs: [],
        localLaunchTimeoutMs: 15_000,
        localCdpReadyTimeoutMs: 8_000,
        ...overrides,
      }) as unknown as ResolvedBrowserConfig;

    async function stubExistingProfile() {
      const executablePath = path.join(tmpDir, "chrome");
      await fsp.writeFile(executablePath, "");
      const existsSync = fs.existsSync.bind(fs);
      vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
        const value = String(candidate);
        return (
          value.endsWith("Local State") || value.endsWith("Preferences") || existsSync(candidate)
        );
      });
      return executablePath;
    }

    const captureFailedLaunchStderr = async (params: {
      port: number;
      chunks: readonly (Buffer | string)[];
      executablePath?: string;
      resolved?: Partial<ResolvedBrowserConfig>;
    }) => {
      stubBrowserExecutableAndPrefs("present", params.executablePath);
      const proc = makeFakeProc();
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => {
          for (const chunk of params.chunks) {
            proc.stderr.emit("data", chunk);
          }
        });
        return proc;
      });
      mockExpiredLaunchPollingClock();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await launchOpenClawChrome(
        makeResolved({ localLaunchTimeoutMs: 1, ...params.resolved }),
        makeProfile(params.port, { executablePath: params.executablePath }),
      ).catch((err: unknown) => err);
      if (!(result instanceof Error)) {
        throw new Error("expected managed Chrome launch to fail");
      }
      return {
        error: result,
        proc,
        stderrHint: result.message.split("Chrome stderr:\n")[1] ?? "",
      };
    };

    it("returns structured no-display details before spawning headed Chrome", async () => {
      const profile = {
        ...makeProfile(51110),
        driver: "openclaw",
        attachOnly: false,
        headless: false,
        headlessSource: "profile",
      } as ResolvedBrowserProfile;
      const error = await launchOpenClawChrome(makeResolved(), profile, {
        platform: "linux",
        env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(BrowserProfileUnavailableError);
      expect(error).toMatchObject({
        metadata: {
          reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
          details: {
            profile: profile.name,
            requestedHeadless: false,
            headlessSource: "profile",
            displayPresent: false,
          },
        },
      });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("throws when no supported browser executable is found", async () => {
      // Strip all candidate executables — override config so no explicit
      // path is set, then mock existsSync to return false for everything.
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const profile = makeProfile(51111);
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
        /No supported browser found/,
      );
      expect(ensurePortAvailableMock).toHaveBeenCalledWith(51111, "127.0.0.1");
    });

    it("rejects a runtime spawn error before polling CDP", async () => {
      stubBrowserExecutableAndPrefs("present");
      const spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      let failedProc: FakeProc | undefined;
      spawnMock.mockImplementation(() => {
        failedProc = makeFailedSpawnProc(spawnError);
        return failedProc;
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();
      const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
      const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");

      await expect(
        launchOpenClawChrome(makeResolved(), makeProfile(51112), {
          signal: controller.signal,
        }),
      ).rejects.toBe(spawnError);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(failedProc?.stderr.listenerCount("data")).toBe(0);
      const spawnAbortListener = addAbortListener.mock.calls.find(
        ([eventName]) => eventName === "abort",
      )?.[1];
      expect(spawnAbortListener).toEqual(expect.any(Function));
      expect(removeAbortListener).toHaveBeenCalledWith("abort", spawnAbortListener);
      controller.abort(new Error("late lifecycle invalidation"));
      expect(failedProc?.kill).not.toHaveBeenCalled();
    });

    it("rejects a bootstrap spawn error without attempting the runtime launch", async () => {
      stubBrowserExecutableAndPrefs("missing");
      const spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      spawnMock.mockImplementation(() => makeFailedSpawnProc(spawnError));

      await expect(launchOpenClawChrome(makeResolved(), makeProfile(51113))).rejects.toBe(
        spawnError,
      );

      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("keeps handling process errors after a successful spawn", async () => {
      stubBrowserExecutableAndPrefs("present");
      const proc = makeFakeProc();
      spawnMock.mockReturnValue(proc);

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/LATE_PROCESS_ERROR",
        run: async (baseUrl) => {
          const running = await launchOpenClawChrome(
            makeResolved(),
            makeProfile(Number(new URL(baseUrl).port)),
          );
          expect(proc.listenerCount("error")).toBeGreaterThan(0);
          expect(() => proc.emit("error", new Error("late child-process error"))).not.toThrow();
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("aborts a deferred managed launch and proves its exact child exited", async () => {
      stubBrowserExecutableAndPrefs("present");
      const proc = makeFakeProc({ pid: 51114 });
      spawnMock.mockReturnValue(proc);
      const probeEntered = deferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          probeEntered.resolve();
          throw new Error("ECONNREFUSED");
        }),
      );
      const controller = new AbortController();
      const reason = new Error("lifecycle invalidated");

      const launch = launchOpenClawChrome(makeResolved(), makeProfile(51114), {
        signal: controller.signal,
      });
      await probeEntered.promise;
      controller.abort(reason);

      await expect(launch).rejects.toBe(reason);
      expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(proc.signalCode).toBe("SIGKILL");
    });

    it("aborts bootstrap immediately and never reaches the runtime launch", async () => {
      stubBrowserExecutableAndPrefs("missing");
      const bootstrap = makeFakeProc({ pid: 51115 });
      const spawned = deferred();
      spawnMock.mockImplementation(() => {
        spawned.resolve();
        return bootstrap;
      });
      const controller = new AbortController();
      const reason = new Error("reset invalidated bootstrap");

      const launch = launchOpenClawChrome(makeResolved(), makeProfile(51115), {
        signal: controller.signal,
      });
      await spawned.promise;
      controller.abort(reason);

      await expect(launch).rejects.toBe(reason);
      expect(bootstrap.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("returns the exact child when abort cleanup cannot prove process exit", async () => {
      stubBrowserExecutableAndPrefs("present");
      const proc = makeFakeProc({
        pid: 51116,
        kill: vi.fn(() => true),
      });
      spawnMock.mockReturnValue(proc);
      const probeEntered = deferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          probeEntered.resolve();
          throw new Error("ECONNREFUSED");
        }),
      );
      const controller = new AbortController();

      const launch = launchOpenClawChrome(makeResolved(), makeProfile(51116), {
        signal: controller.signal,
      });
      await probeEntered.promise;
      controller.abort(new Error("stop invalidated launch"));
      const error = await launch.catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ManagedChromeCleanupError);
      expect(error).toMatchObject({ running: { pid: 51116, proc } });
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it.each([{ cdpUrl: "http://[::1]:51111", configuredProbeHost: "::1" }])(
      "checks Chrome's IPv4 bind and the configured $configuredProbeHost endpoint",
      async ({ cdpUrl, configuredProbeHost }) => {
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        const portBusy = new Error("Port is already in use.");
        portBusy.name = "PortInUseError";
        ensurePortAvailableMock.mockImplementation(async (_port, host) => {
          if (host === configuredProbeHost) {
            throw portBusy;
          }
        });
        const profile = { ...makeProfile(51111), cdpUrl };

        await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(portBusy);
        expect(ensurePortAvailableMock.mock.calls).toEqual([
          [51111, "127.0.0.1"],
          [51111, configuredProbeHost],
        ]);
      },
    );

    it("completes successfully when Chrome reports /json/version and CDP is reachable", async () => {
      // Mock executable discovery to a truthy path.
      stubBrowserExecutableAndPrefs("present");

      let spawnCalls = 0;
      spawnMock.mockImplementation(() => {
        spawnCalls += 1;
        return makeFakeProc();
      });
      vi.stubEnv("HTTP_PROXY", "http://proxy.test:8080");
      vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8443");
      vi.stubEnv("NO_PROXY", "localhost");
      vi.stubEnv("XDG_CONFIG_HOME", undefined);
      vi.stubEnv("XDG_CACHE_HOME", undefined);

      // Set up a real HTTP server impersonating Chrome's /json/version.
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/LAUNCHED",
        run: async (baseUrl) => {
          const port = new URL(baseUrl).port;
          const profile = makeProfile(Number(port));
          const running = await launchOpenClawChrome(makeResolved(), profile);
          expect(running.pid).toBe(4242);
          expect(spawnCalls).toBeGreaterThanOrEqual(1);
          const spawnOptions = requireSpawnOptions();
          expect(spawnOptions.env?.HTTP_PROXY).toBeUndefined();
          expect(spawnOptions.env?.HTTPS_PROXY).toBeUndefined();
          expect(spawnOptions.env?.NO_PROXY).toBeUndefined();
          if (process.platform === "linux") {
            expect(spawnOptions.env?.XDG_CONFIG_HOME).toEqual(expect.any(String));
            expect(spawnOptions.env?.XDG_CACHE_HOME).toEqual(expect.any(String));
          }
          // Cleanup.
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("accepts a ready CDP diagnostic after the launch HTTP probe expires", async () => {
      stubBrowserExecutableAndPrefs("present");
      spawnMock.mockImplementation(() => makeFakeProc());

      const originalFetch = globalThis.fetch;
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let discoveryCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/json/version")) {
            discoveryCalls += 1;
            if (discoveryCalls === 1) {
              now += 2;
              throw new Error("ECONNREFUSED");
            }
          }
          return await originalFetch(input, init);
        }),
      );

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/COLD_START",
        run: async (baseUrl) => {
          const port = new URL(baseUrl).port;
          const profile = makeProfile(Number(port));
          const running = await launchOpenClawChrome(
            makeResolved({ localLaunchTimeoutMs: 1 }),
            profile,
          );
          expect(running.pid).toBe(4242);
          expect(discoveryCalls).toBeGreaterThan(1);
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("keeps the launched process when fallback diagnostic sees HTTP before WS readiness", async () => {
      stubBrowserExecutableAndPrefs("present");
      const fakeProc = makeFakeProc();
      spawnMock.mockImplementation(() => fakeProc);

      const originalFetch = globalThis.fetch;
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let discoveryCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/json/version")) {
            discoveryCalls += 1;
            if (discoveryCalls === 1) {
              now += 2;
              throw new Error("ECONNREFUSED");
            }
          }
          return await originalFetch(input, init);
        }),
      );

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/WS_WARMING",
        onCommand: () => undefined,
        run: async (baseUrl) => {
          const port = new URL(baseUrl).port;
          const profile = makeProfile(Number(port));
          const running = await launchOpenClawChrome(
            makeResolved({ localLaunchTimeoutMs: 1 }),
            profile,
          );
          expect(running.pid).toBe(4242);
          expect(discoveryCalls).toBeGreaterThan(1);
          expect(fakeProc.kill).not.toHaveBeenCalledWith("SIGKILL");
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("preserves locked profile data when the lock names another hostname", async () => {
      stubBrowserExecutableAndPrefs("present");
      const profile = makeProfile(51118);
      const userDataDir = resolveOpenClawUserDataDir(profile.name);
      const localStatePath = path.join(userDataDir, "Local State");
      const originalState = '{"untouched":true}';
      await fsp.mkdir(path.join(userDataDir, "Default"), { recursive: true });
      await fsp.writeFile(localStatePath, originalState);
      await fsp.writeFile(path.join(userDataDir, "Default", "Preferences"), "{}");
      await fsp.symlink(`${os.hostname()}-previous-43213`, path.join(userDataDir, "SingletonLock"));
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      mockExpiredLaunchPollingClock();
      spawnMock.mockImplementation(() => makeFakeProc());
      try {
        await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow();
        expect(await fsp.readFile(localStatePath, "utf8")).toBe(originalState);
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        await fsp.rm(userDataDir, { recursive: true, force: true });
      }
    });

    it("clears stale singleton locks even when the profile-in-use marker rolls out of the stderr tail", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      const configPath = path.join(tmpDir, "openclaw.json");
      await fsp.writeFile(
        configPath,
        JSON.stringify({
          logging: {
            redactPatterns: ["profile appears to be in use by another Chromium process"],
          },
        }),
      );
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      let cdpReachable = false;
      const originalFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!cdpReachable) {
            throw new Error("ECONNREFUSED");
          }
          return await originalFetch(input, init);
        }),
      );
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (s === "/tmp/profile-chrome" || s.endsWith("Local State") || s.endsWith("Preferences")) {
          return true;
        }
        return false;
      });

      let spawnCalls = 0;
      const firstProc = makeFakeProc();
      const secondProc = makeFakeProc();
      const laterStderr = Buffer.alloc(70 * 1024, "x");
      mockExpiredLaunchPollingClock();
      spawnMock.mockImplementation(() => {
        spawnCalls += 1;
        if (spawnCalls === 1) {
          void Promise.resolve().then(() => {
            firstProc.stderr.emit(
              "data",
              Buffer.from("The profile appears to be in use by another Chromium process"),
            );
            firstProc.stderr.emit("data", laterStderr);
          });
          return firstProc;
        }
        cdpReachable = true;
        return secondProc;
      });

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/SINGLETON_RETRY",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = { ...makeProfile(port), executablePath: "/tmp/profile-chrome" };
          const userDataDir = resolveOpenClawUserDataDir(profile.name);
          await fsp.mkdir(userDataDir, { recursive: true });
          await fsp.writeFile(path.join(userDataDir, "SingletonCookie"), "cookie");
          await fsp.writeFile(path.join(userDataDir, "SingletonSocket"), "socket");
          await fsp.symlink(`${os.hostname()}-535`, path.join(userDataDir, "SingletonLock"));

          try {
            const running = await launchOpenClawChrome(
              makeResolved({ localLaunchTimeoutMs: 20 }),
              profile,
            );
            expect(running.proc).toBe(secondProc);
            expect(firstProc.kill).toHaveBeenCalledWith("SIGKILL");
            expect(spawnCalls).toBe(2);
            expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
            expect(fs.existsSync(path.join(userDataDir, "SingletonSocket"))).toBe(false);
            running.proc.kill?.("SIGTERM");
          } finally {
            await fsp.rm(userDataDir, { recursive: true, force: true });
          }
        },
      });
    });

    it.runIf(process.platform === "linux")(
      "recovers a current-host profile locked by a zombie process",
      async ({ signal }) => {
        const zombie = startLinuxZombieProcess();
        try {
          const zombiePid = await withinTest(zombie.ready, signal);
          let cdpReachable = false;
          const originalFetch = globalThis.fetch;
          vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
              if (!cdpReachable) {
                throw new Error("ECONNREFUSED");
              }
              return await originalFetch(input, init);
            }),
          );
          const executablePath = await stubExistingProfile();

          const firstProc = makeFakeProc();
          const secondProc = makeFakeProc();
          let spawnCalls = 0;
          mockExpiredLaunchPollingClock();
          spawnMock.mockImplementation(() => {
            spawnCalls += 1;
            if (spawnCalls === 1) {
              queueMicrotask(() => {
                firstProc.stderr.emit(
                  "data",
                  Buffer.from("The profile appears to be in use by another Chromium process"),
                );
              });
              return firstProc;
            }
            cdpReachable = true;
            return secondProc;
          });

          await withMockChromeCdpServer({
            wsPath: "/devtools/browser/ZOMBIE_SINGLETON_RETRY",
            run: async (baseUrl) => {
              const port = Number(new URL(baseUrl).port);
              const profile = {
                ...makeProfile(port),
                cdpUrl: baseUrl,
                executablePath,
              } as ResolvedBrowserProfile;
              const userDataDir = resolveOpenClawUserDataDir(profile.name);
              await fsp.mkdir(userDataDir, { recursive: true });
              await fsp.writeFile(path.join(userDataDir, "SingletonCookie"), "cookie");
              await fsp.writeFile(path.join(userDataDir, "SingletonSocket"), "socket");
              await fsp.symlink(
                `${os.hostname()}-${zombiePid}`,
                path.join(userDataDir, "SingletonLock"),
              );

              try {
                const running = await launchOpenClawChrome(
                  makeResolved({ localLaunchTimeoutMs: 20 }),
                  profile,
                );
                expect(running.proc).toBe(secondProc);
                expect(firstProc.kill).toHaveBeenCalledWith("SIGKILL");
                expect(spawnCalls).toBe(2);
                expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
                expect(fs.existsSync(path.join(userDataDir, "SingletonSocket"))).toBe(false);
                running.proc.kill?.("SIGTERM");
              } finally {
                await fsp.rm(userDataDir, { recursive: true, force: true });
              }
            },
          });
        } finally {
          await zombie.reap();
        }
      },
      15_000,
    );

    it("preserves the exact surviving child when a singleton retry cleanup fails", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const value = String(p);
        return (
          value === "/tmp/profile-chrome" ||
          value.endsWith("Local State") ||
          value.endsWith("Preferences")
        );
      });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      mockExpiredLaunchPollingClock();

      const firstProc = makeFakeProc({ pid: 62001 });
      const survivingProc = makeFakeProc({
        pid: 62002,
        kill: vi.fn(() => true),
      });

      let spawnCalls = 0;
      spawnMock.mockImplementation(() => {
        spawnCalls += 1;
        if (spawnCalls === 1) {
          queueMicrotask(() => {
            firstProc.stderr.emit(
              "data",
              Buffer.from("The profile appears to be in use by another Chromium process"),
            );
          });
          return firstProc;
        }
        return survivingProc;
      });

      const profile = { ...makeProfile(51109), executablePath: "/tmp/profile-chrome" };
      const userDataDir = resolveOpenClawUserDataDir(profile.name);
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.symlink(`${os.hostname()}-62001`, path.join(userDataDir, "SingletonLock"));

      try {
        const error = await launchOpenClawChrome(
          makeResolved({ localLaunchTimeoutMs: 20 }),
          profile,
        ).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(ManagedChromeCleanupError);
        expect(error).toMatchObject({ running: { pid: 62002, proc: survivingProc } });
        expect(firstProc.kill).toHaveBeenCalledWith("SIGKILL");
        expect(survivingProc.kill).toHaveBeenCalledWith("SIGKILL");
        expect(spawnCalls).toBe(2);
      } finally {
        await fsp.rm(userDataDir, { recursive: true, force: true });
      }
    });

    it("stops a lock-owned stale managed CDP listener before relaunching", async () => {
      const originalPlatform = process.platform;
      const executablePath = await stubExistingProfile();
      const portBusy = new Error("Port is already in use.");
      portBusy.name = "PortInUseError";
      ensurePortAvailableMock.mockRejectedValueOnce(portBusy).mockResolvedValue(undefined);

      const stalePid = 43210;
      let staleProcessAlive = true;
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
        if (pid !== stalePid) {
          return true;
        }
        if (signal === 0) {
          if (staleProcessAlive) {
            return true;
          }
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        if (signal === "SIGTERM") {
          staleProcessAlive = false;
          return true;
        }
        return true;
      }) as typeof process.kill);

      const fakeProc = makeFakeProc();
      spawnMock.mockReturnValue(fakeProc);

      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        await withMockChromeCdpServer({
          wsPath: "/devtools/browser/STALE_OWNER",
          onCommand: () => undefined,
          run: async (baseUrl) => {
            const port = Number(new URL(baseUrl).port);
            const profile = {
              ...makeProfile(port),
              cdpUrl: baseUrl,
              executablePath,
            } as ResolvedBrowserProfile;
            const userDataDir = resolveOpenClawUserDataDir(profile.name);
            mockLinuxManagedChromeOwnership({
              pid: stalePid,
              port,
              executablePath,
              userDataDir,
            });
            await fsp.mkdir(userDataDir, { recursive: true });
            await fsp.writeFile(path.join(userDataDir, "SingletonCookie"), "cookie");
            await fsp.writeFile(path.join(userDataDir, "SingletonSocket"), "socket");
            await fsp.symlink(
              `${os.hostname()}-${stalePid}`,
              path.join(userDataDir, "SingletonLock"),
            );

            try {
              const running = await launchOpenClawChrome(makeResolved(), profile);
              expect(running.proc).toBe(fakeProc);
              expect(ensurePortAvailableMock).toHaveBeenCalledTimes(2);
              expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
              expect(spawnMock).toHaveBeenCalledTimes(1);
              expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
              expect(fs.existsSync(path.join(userDataDir, "SingletonSocket"))).toBe(false);
              running.proc.kill?.("SIGTERM");
            } finally {
              await fsp.rm(userDataDir, { recursive: true, force: true });
            }
          },
        });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it.each([
      { name: "missing", error: "ENOENT", target: "", expected: "not-running" },
      { name: "unreadable", error: "EACCES", target: "", expected: "unverified" },
      { name: "malformed", error: "", target: "not-a-chromium-lock", expected: "unverified" },
      { name: "invalid pid", error: "", target: `${os.hostname()}-0`, expected: "unverified" },
      {
        name: "different hostname",
        error: "",
        target: `${os.hostname()}-previous-43213`,
        expected: "unverified",
      },
      {
        name: "unproven live owner",
        error: "",
        target: `${os.hostname()}-43213`,
        expected: "unverified",
      },
    ])(
      "distinguishes a $name profile lock before releasing data",
      async ({ error, target, expected }) => {
        stubBrowserExecutableAndPrefs("present");
        const profile = { ...makeProfile(51117), driver: "openclaw" as const };
        const lockPath = path.join(resolveOpenClawUserDataDir(profile.name), "SingletonLock");
        const readlink = fs.readlinkSync.bind(fs);
        vi.spyOn(fs, "readlinkSync").mockImplementation((candidate, options) => {
          if (String(candidate) !== lockPath) {
            return readlink(candidate, options);
          }
          if (error) {
            throw Object.assign(new Error(error), { code: error });
          }
          return target;
        });
        const signal = vi.spyOn(process, "kill").mockReturnValue(true);

        await expect(stopOwnedOpenClawChrome(makeResolved(), profile)).resolves.toMatchObject({
          status: expected,
        });
        expect(signal).not.toHaveBeenCalledWith(43213, "SIGTERM");
        expect(signal).not.toHaveBeenCalledWith(43213, "SIGKILL");
      },
    );

    it.each([
      {
        name: "directory with spaces",
        suffix: "",
        profileSuffix: " with spaces",
        replaceLock: false,
      },
      {
        name: "space-suffixed directory",
        suffix: " backup",
        profileSuffix: "",
        replaceLock: false,
      },
      {
        name: "replacement lock from another host",
        suffix: "",
        profileSuffix: "",
        replaceLock: true,
      },
    ])(
      "keeps cross-runtime cleanup bound to the $name",
      async ({ suffix, profileSuffix, replaceLock }) => {
        const originalPlatform = process.platform;
        const executablePath = await stubExistingProfile();

        const managedPid = 43213;
        let managedProcessAlive = true;
        let processStartTime = "Fri Jul 17 12:00:00 2026";
        let rotateProcessIdentity = true;
        let userDataDir = "";
        const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
          if (pid === managedPid && signal === 0 && !managedProcessAlive) {
            const error = new Error("no such process") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
          }
          return true;
        }) as typeof process.kill);
        const connectionSpy = vi.spyOn(Agent.prototype, "createConnection");

        Object.defineProperty(process, "platform", { value: "darwin" });
        try {
          await withMockChromeCdpServer({
            wsPath: "/devtools/browser/CROSS_PROCESS_OWNER",
            onCommand: (method) => {
              if (method === "SystemInfo.getProcessInfo") {
                if (rotateProcessIdentity) {
                  processStartTime = "Fri Jul 17 12:01:00 2026";
                  rotateProcessIdentity = false;
                }
                return { processInfo: [{ type: "browser", id: managedPid }] };
              }
              expect(method).toBe("Browser.close");
              managedProcessAlive = false;
              if (replaceLock) {
                fs.unlinkSync(path.join(userDataDir, "SingletonLock"));
                fs.symlinkSync(
                  `${os.hostname()}-previous-43214`,
                  path.join(userDataDir, "SingletonLock"),
                );
              }
              return {};
            },
            run: async (baseUrl) => {
              const port = Number(new URL(baseUrl).port);
              const profile = makeBrowserProfile({
                name: `${path.basename(tmpDir)}${profileSuffix}`,
                cdpUrl: baseUrl,
                cdpPort: port,
                executablePath,
              });
              userDataDir = resolveOpenClawUserDataDir(profile.name);
              execFileSyncMock.mockImplementation((command: string, args: string[]) => {
                if (command === "ps" && args.includes("command=")) {
                  return `${executablePath} --remote-debugging-port=${port} --user-data-dir=${userDataDir}${suffix} --no-first-run\n`;
                }
                if (path.basename(command) === "ps" && args.includes("lstart=")) {
                  return `${processStartTime}\n`;
                }
                if (command === "lsof") {
                  return `p${managedPid}\n`;
                }
                throw new Error(`unexpected command: ${command}`);
              });
              await fsp.mkdir(userDataDir, { recursive: true });
              await fsp.symlink(
                `${os.hostname()}-${managedPid}`,
                path.join(userDataDir, "SingletonLock"),
              );

              try {
                const resolved = makeResolved({
                  ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
                });
                await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
                  status: "unverified",
                });
                expect(managedProcessAlive).toBe(true);
                expect(killSpy).not.toHaveBeenCalledWith(managedPid, "SIGTERM");
                await expect(
                  fsp.lstat(path.join(userDataDir, "SingletonLock")),
                ).resolves.toBeTruthy();

                await expect(stopOwnedOpenClawChrome(resolved, profile)).resolves.toMatchObject({
                  status: suffix || replaceLock ? "unverified" : "stopped",
                });
                if (!suffix) {
                  expect(
                    connectionSpy.mock.calls.some(
                      ([options]) => typeof options.lookup === "function",
                    ),
                  ).toBe(true);
                }
                expect(killSpy).not.toHaveBeenCalledWith(managedPid, "SIGTERM");
                expect(killSpy).not.toHaveBeenCalledWith(managedPid, "SIGKILL");
                expect(managedProcessAlive).toBe(Boolean(suffix));
                if (suffix || replaceLock) {
                  await expect(fsp.readlink(path.join(userDataDir, "SingletonLock"))).resolves.toBe(
                    replaceLock
                      ? `${os.hostname()}-previous-43214`
                      : `${os.hostname()}-${managedPid}`,
                  );
                } else {
                  await expect(
                    fsp.lstat(path.join(userDataDir, "SingletonLock")),
                  ).rejects.toMatchObject({ code: "ENOENT" });
                }
              } finally {
                await fsp.rm(userDataDir, { recursive: true, force: true });
              }
            },
          });
        } finally {
          Object.defineProperty(process, "platform", { value: originalPlatform });
        }
      },
    );

    it("does not stop a current-host lock pid without managed Chrome ownership proof", async () => {
      const originalPlatform = process.platform;
      const executablePath = await stubExistingProfile();
      const portBusy = new Error("Port is already in use.");
      portBusy.name = "PortInUseError";
      ensurePortAvailableMock.mockRejectedValue(portBusy);

      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        for (const testCase of [
          { pid: 43211, ownsPort: false, argvExecutablePath: executablePath, extraArgs: [] },
          {
            pid: 43212,
            ownsPort: true,
            argvExecutablePath: path.join(tmpDir, "other-browser"),
            extraArgs: [],
          },
          {
            pid: 43215,
            ownsPort: true,
            argvExecutablePath: executablePath,
            extraArgs: ["--user-data-dir=/another-profile"],
          },
        ]) {
          await withMockChromeCdpServer({
            wsPath: `/devtools/browser/STALE_NON_OWNER_${testCase.pid}`,
            onCommand: () => undefined,
            run: async (baseUrl) => {
              const port = Number(new URL(baseUrl).port);
              const profile = {
                ...makeProfile(port),
                cdpUrl: baseUrl,
                executablePath,
              } as ResolvedBrowserProfile;
              const userDataDir = resolveOpenClawUserDataDir(`${profile.name}-${testCase.pid}`);
              const profileWithUniqueName = {
                ...profile,
                name: `${profile.name}-${testCase.pid}`,
              } as ResolvedBrowserProfile;
              mockLinuxManagedChromeOwnership({
                pid: testCase.pid,
                port,
                executablePath,
                argvExecutablePath: testCase.argvExecutablePath,
                userDataDir,
                ownsPort: testCase.ownsPort,
                extraArgs: testCase.extraArgs,
              });
              await fsp.mkdir(userDataDir, { recursive: true });
              await fsp.symlink(
                `${os.hostname()}-${testCase.pid}`,
                path.join(userDataDir, "SingletonLock"),
              );

              try {
                await expect(
                  launchOpenClawChrome(makeResolved(), profileWithUniqueName),
                ).rejects.toThrow("Port is already in use.");
                expect(killSpy).not.toHaveBeenCalledWith(testCase.pid, "SIGTERM");
                expect(spawnMock).not.toHaveBeenCalled();
                await expect(
                  fsp.lstat(path.join(userDataDir, "SingletonLock")),
                ).resolves.toBeTruthy();
              } finally {
                await fsp.rm(userDataDir, { recursive: true, force: true });
              }
            },
          });
        }
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("does not stop a stale CDP listener without current-host profile ownership proof", async () => {
      const portBusy = new Error("Port is already in use.");
      portBusy.name = "PortInUseError";
      ensurePortAvailableMock.mockRejectedValue(portBusy);
      const killSpy = vi.spyOn(process, "kill");

      const profile = makeProfile(55554);
      const userDataDir = resolveOpenClawUserDataDir(profile.name);
      await fsp.mkdir(userDataDir, { recursive: true });
      await fsp.symlink("remote-host-43210", path.join(userDataDir, "SingletonLock"));

      try {
        await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
          "Port is already in use.",
        );
        expect(killSpy).not.toHaveBeenCalledWith(43210, "SIGTERM");
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        await fsp.rm(userDataDir, { recursive: true, force: true });
      }
    });

    it("keeps only a bounded UTF-8-safe newest stderr tail when launch fails after large stderr", async () => {
      const oldMarker = "older-stderr-marker";
      const newestMarker = "newest-stderr-marker";
      const splitEmoji = Buffer.from("🦞");
      const newestLine = Buffer.from(`\n${newestMarker}\n`);
      const tailMaxBytes = 64 * 1024;
      const filler = Buffer.alloc(tailMaxBytes + 2 - splitEmoji.length - newestLine.length, "x");
      const { error, proc, stderrHint } = await captureFailedLaunchStderr({
        port: 55557,
        chunks: [
          Buffer.from(`${oldMarker}\n`),
          splitEmoji.subarray(0, 2),
          Buffer.concat([splitEmoji.subarray(2), filler, newestLine]),
        ],
      });

      expect(error.message).toMatch(/Failed to start Chrome CDP/);
      expect(stderrHint).not.toContain(oldMarker);
      expect(stderrHint).toContain(newestMarker);
      expect(stderrHint).not.toContain("�");
      expect(stderrHint.length).toBeLessThanOrEqual(CHROME_STDERR_HINT_MAX_CHARS);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("does not split a surrogate pair at the stderr hint char-cap boundary", async () => {
      const newestMarker = "newest-stderr-marker";
      const tail = `${newestMarker}${"y".repeat(CHROME_STDERR_HINT_MAX_CHARS - 1 - newestMarker.length)}`;
      // The raw cap starts on 🦞's low surrogate; the safe slice drops the pair.
      const { stderrHint } = await captureFailedLaunchStderr({
        port: 55559,
        chunks: [`${"x".repeat(50)}🦞${tail}`],
      });

      expect(stderrHint).toBe(tail);
    });

    it("retains launch hints after the stderr tail rolls", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        const executablePath = path.join(tmpDir, "chrome");
        await fsp.writeFile(executablePath, "");
        const { error, proc, stderrHint } = await captureFailedLaunchStderr({
          port: 55558,
          executablePath,
          resolved: { headless: false, noSandbox: false },
          chunks: [Buffer.from("Missing X server or $DISPLAY\n"), Buffer.alloc(70 * 1024, "x")],
        });
        expect(error.message).toContain("No DISPLAY/X server was detected");
        expect(error.message).toContain("browser.noSandbox: true");
        expect(stderrHint).not.toContain("$DISPLAY");
        expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("reuses existing preferences without bootstrapping another Chrome", async () => {
      try {
        const profileName = path.basename(tmpDir);
        const colorHex = "#FF4500";
        const colorInt = ((0xff << 24) | 0xff4500) >> 0;
        const userDataDir = path.join(resolveOpenClawUserDataDir(profileName));
        await fsp.mkdir(path.join(userDataDir, "Default"), { recursive: true });
        await fsp.writeFile(
          path.join(userDataDir, "Local State"),
          JSON.stringify({
            profile: {
              info_cache: {
                Default: {
                  name: profileName,
                  profile_color_seed: colorInt,
                },
              },
            },
          }),
        );
        await fsp.writeFile(
          path.join(userDataDir, "Default", "Preferences"),
          JSON.stringify({
            browser: { theme: { user_color2: colorInt } },
            autogenerated: { theme: { color: colorInt } },
            custom: { preserved: true },
          }),
        );
        const existsSync = fs.existsSync.bind(fs);
        vi.spyOn(fs, "existsSync").mockImplementation((p) => {
          const s = String(p);
          if (
            s.includes("Google Chrome") ||
            s.includes("google-chrome") ||
            s.includes("/usr/bin/chromium")
          ) {
            return true;
          }
          return existsSync(p);
        });
        spawnMock.mockImplementation(() => makeFakeProc());
        await withMockChromeCdpServer({
          wsPath: "/devtools/browser/DECORATED",
          run: async (baseUrl) => {
            const port = Number(new URL(baseUrl).port);
            const profile = makeBrowserProfile({
              name: profileName,
              color: colorHex,
              cdpPort: port,
              cdpUrl: baseUrl,
              headless: true,
            });
            const { resolved } = makeBrowserServerState({
              profile,
              resolvedOverrides: { noSandbox: true },
            });
            const running = await launchOpenClawChrome(resolved, profile);
            expect(running.pid).toBe(4242);
            expect(spawnMock).toHaveBeenCalledOnce();
            expect(
              JSON.parse(
                await fsp.readFile(path.join(userDataDir, "Default", "Preferences"), "utf8"),
              ),
            ).toMatchObject({ custom: { preserved: true } });
            running.proc.kill?.("SIGTERM");
          },
        });
      } finally {
        const staged = resolveOpenClawUserDataDir(path.basename(tmpDir));
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("redacts launch stderr even when log redaction is disabled", async () => {
      const state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-redact-off-",
      });
      try {
        await state.writeConfig({ logging: { redactSensitive: "off" } });
        const executablePath = path.join(state.root, "chrome-stderr-existing");
        await fsp.writeFile(executablePath, "");
        const secretToken = "chrome-stderr-secret-1234567890"; // pragma: allowlist secret
        const { error } = await captureFailedLaunchStderr({
          port: 54321,
          executablePath,
          chunks: [Buffer.from(`chrome crash log token=${secretToken}\n`)],
        });
        expect(error.message).toContain("Chrome stderr:");
        expect(error.message).toContain("chrome crash log");
        expect(error.message).not.toContain(secretToken);
      } finally {
        await state.cleanup();
      }
    });

    it("omits the sandbox hint on non-linux platforms", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      try {
        const { error } = await captureFailedLaunchStderr({
          port: 54322,
          chunks: [],
          resolved: { noSandbox: false },
        });
        expect(error.message).not.toContain("Hint: If running in a container");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("breaks out of the bootstrap prefs-wait loop as soon as both files exist", async () => {
      // Covers the `if (exists(localStatePath) && exists(preferencesPath)) break;` branch.
      // The first prefs probe makes bootstrap necessary; subsequent probes
      // make both prefs files visible so the polling loop breaks immediately.
      let prefsProbeCount = 0;
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const s = String(p);
        if (
          s.includes("Google Chrome") ||
          s.includes("google-chrome") ||
          s.includes("/usr/bin/chromium")
        ) {
          return true;
        }
        if (s.endsWith("Local State") || s.endsWith("Preferences")) {
          prefsProbeCount += 1;
          return prefsProbeCount > 1;
        }
        return false;
      });
      const bootstrapProc = makeFakeProc({ exitCode: 0 });
      const runtimeProc = makeFakeProc();
      let spawnCount = 0;
      spawnMock.mockImplementation(() => {
        spawnCount += 1;
        return spawnCount === 1 ? bootstrapProc : runtimeProc;
      });
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/BOOTSTRAP_BREAK",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const running = await launchOpenClawChrome(
            makeResolved({ localLaunchTimeoutMs: 20 }),
            makeProfile(port),
          );
          expect(spawnCount).toBe(2);
          expect(running.proc).toBe(runtimeProc);
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("rejects if a spawn event arrives without a process id", async () => {
      stubBrowserExecutableAndPrefs("present");
      spawnMock.mockImplementation(() => {
        const fp = makeFakeProc();
        fp.pid = undefined;
        queueMicrotask(() => fp.emit("spawn"));
        return fp;
      });
      await expect(
        launchOpenClawChrome(makeResolved({ localLaunchTimeoutMs: 20 }), makeProfile(54325)),
      ).rejects.toThrow("Managed Chrome process spawned without a pid.");
    });

    it("preflights managed-proxy policy and registers exact CDP probe URLs", async () => {
      stubBrowserExecutableAndPrefs("present");
      const release = vi.fn();
      registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => release);
      spawnMock.mockImplementation(() => makeFakeProc());

      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/BYPASS_OK",
        run: async (baseUrl) => {
          const port = Number(new URL(baseUrl).port);
          const profile = { ...makeProfile(port), cdpUrl: baseUrl };
          const running = await launchOpenClawChrome(makeResolved(), profile);
          expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(baseUrl);
          expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
            `${baseUrl}/json/version`,
          );
          expect(release).toHaveBeenCalled();
          running.proc.kill?.("SIGTERM");
        },
      });
    });

    it("releases scoped bypass registrations when the CDP probe never succeeds", async () => {
      stubBrowserExecutableAndPrefs("present");
      const release = vi.fn();
      registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => release);
      const fakeProc = makeFakeProc();
      spawnMock.mockImplementation(() => fakeProc);
      mockExpiredLaunchPollingClock();
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const profile = makeProfile(54323);
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
        /Failed to start Chrome CDP/,
      );
      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(profile.cdpUrl);
      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
        `${profile.cdpUrl}/json/version`,
      );
      expect(release).toHaveBeenCalledTimes(
        registerManagedProxyBrowserCdpBypassMock.mock.calls.length,
      );
    });

    it("surfaces loopbackMode=block as BrowserProfileUnavailableError without spawning Chrome", async () => {
      registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => {
        throw new Error(
          "proxy: Browser loopback CDP connections are blocked by proxy.loopbackMode",
        );
      });
      const profile = makeProfile(54324);
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toBeInstanceOf(
        BrowserProfileUnavailableError,
      );
      await expect(launchOpenClawChrome(makeResolved(), profile)).rejects.toThrow(
        /blocked by proxy\.loopbackMode/,
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("does not register a bypass for a remote attachOnly CDP URL (loopback gate)", async () => {
      stubBrowserExecutableAndPrefs("present");
      const remoteProfile = makeProfile(19222, {
        cdpUrl: "http://browserless.example.com:19222",
        cdpIsLoopback: false,
      });
      await expect(launchOpenClawChrome(makeResolved(), remoteProfile)).rejects.toThrow(
        /is remote; cannot launch local Chrome/,
      );
      expect(registerManagedProxyBrowserCdpBypassMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe("canRunCdpHealthCommand branches", () => {
    it("returns false when the health command response is malformed JSON", async () => {
      await withMockChromeCdpServer({
        wsPath: "/devtools/browser/BAD_JSON",
        onConnection: (wss) => {
          wss.on("connection", (ws) => {
            ws.on("message", () => {
              ws.send("not-json-at-all");
              setImmediate(() => ws.close());
            });
          });
        },
        run: async (baseUrl) => {
          await expect(isChromeCdpReady(baseUrl, 50, 10)).resolves.toBe(false);
        },
      });
    });
  });

  describe("isChromeCdpReady swallowed errors", () => {
    it("returns false when a strict SSRF policy blocks the CDP endpoint", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }),
        } as unknown as Response),
      );
      await expect(
        isChromeCdpReady("http://169.254.169.254:9222", 50, 50, {
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: ["127.0.0.1"],
        }),
      ).resolves.toBe(false);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
