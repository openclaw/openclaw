import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const findCallInStoreMock = vi.hoisted(() => vi.fn());
const loadActiveCallsFromStoreMock = vi.hoisted(() => vi.fn());
const tailscaleMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  getSelfInfo: vi.fn(),
  setup: vi.fn(),
}));
const sleepMock = vi.hoisted(() =>
  vi.fn(
    async (ms: number) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  ),
);

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  sleep: sleepMock,
}));
vi.mock("./manager/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manager/store.js")>()),
  findCallInStore: findCallInStoreMock,
  loadActiveCallsFromStore: loadActiveCallsFromStoreMock,
}));
vi.mock("./webhook/tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook/tailscale.js")>()),
  cleanupTailscaleExposureRoute: tailscaleMocks.cleanup,
  getTailscaleSelfInfo: tailscaleMocks.getSelfInfo,
  setupTailscaleExposureRoutes: tailscaleMocks.setup,
}));

import { registerVoiceCallCli } from "./cli.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function captureStdout(onOutput?: (output: string) => void) {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    onOutput?.(output);
    return true;
  }) as typeof process.stdout.write);
  return () => output;
}

function runCli(program: Command, args: string[]) {
  return program.parseAsync(["voicecall", ...args], { from: "user" });
}

function commandArgs(command: string, options: Record<string, string>) {
  return [command, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
}

async function captureCli(program: Command, args: string[]) {
  const capture = captureStdout();
  await runCli(program, args);
  return capture();
}

const continueArgs = ["continue", "--call-id", "call-1", "--message", "hello"];

function gatewayTransportError(
  code?: number,
  url = "ws://127.0.0.1:18789",
  message = "gateway transport failed",
): Error {
  return Object.assign(new Error(message), {
    name: "GatewayTransportError",
    kind: "closed",
    connectionDetails: { url },
    ...(code === undefined ? {} : { code }),
  });
}

function gatewayRequestError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode: "UNAVAILABLE",
    retryable: false,
  });
}

function gatewayCredentialsError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "GatewayCredentialsRequiredError",
    method: "voicecall.status",
    configPath: "/tmp/openclaw.json",
  });
}

describe("voice-call CLI status fallback", () => {
  afterEach(() => {
    callGatewayFromCliMock.mockReset();
    findCallInStoreMock.mockReset();
    loadActiveCallsFromStoreMock.mockReset();
    tailscaleMocks.cleanup.mockReset();
    tailscaleMocks.getSelfInfo.mockReset();
    tailscaleMocks.setup.mockReset();
    sleepMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildProgram(
    manager: Record<string, unknown>,
    config: Record<string, unknown> = {},
    ensureRuntime = async () => ({ manager }) as never,
    options: Partial<Parameters<typeof registerVoiceCallCli>[0]> = {},
  ): Command {
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: config as never,
      coreConfig: {},
      ensureRuntime,
      ...options,
    });
    return program;
  }

  const run = (args: string[], config: Record<string, unknown> = {}) =>
    runCli(buildProgram({}, config), args);
  const capture = async (args: string[], config: Record<string, unknown> = {}) =>
    JSON.parse(await captureCli(buildProgram({}, config), args));
  it("reports an ambiguous phone-call owner during setup without starting telephony", async () => {
    const ensureRuntime = vi.fn();
    const program = buildProgram({}, createVoiceCallBaseConfig(), ensureRuntime, {
      coreConfig: {
        agents: { ownership: "explicit", entries: { operator: {}, support: {} } },
      },
    });
    const output = await captureCli(program, ["setup", "--json"]);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([
        {
          id: "agent-owner",
          ok: false,
          message: expect.stringContaining(
            "Set plugins.entries.voice-call.config.agentId to a configured agent ID.",
          ),
        },
      ]),
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["persisted", undefined],
    ["persisted", 1006],
    ["missing", undefined],
    ["active", undefined],
  ] as const)("reads %s status after gateway close %s without telephony", async (kind, code) => {
    const persisted = { callId: "call-1", state: "completed" };
    const active = { callId: "call-1", state: "ringing" };
    callGatewayFromCliMock.mockRejectedValue(gatewayTransportError(code));
    findCallInStoreMock.mockResolvedValue(kind === "persisted" ? persisted : undefined);
    if (kind === "active") {
      loadActiveCallsFromStoreMock.mockResolvedValue({
        activeCalls: new Map([["call-1", active]]),
      });
    }
    const ensureRuntime = vi.fn(async () => {
      throw new Error("status fallback must not initialize the telephony runtime");
    });
    const program = buildProgram({}, {}, ensureRuntime, { stateRuntime: {} as never });
    const output = await captureCli(program, [
      "status",
      ...(kind === "active" ? [] : ["--call-id", "call-1"]),
      "--json",
    ]);
    expect(ensureRuntime).not.toHaveBeenCalled();
    if (kind === "persisted") {
      expect(JSON.parse(output)).toMatchObject(persisted);
    } else {
      expect(JSON.parse(output)).toEqual(
        kind === "active" ? { found: true, calls: [active] } : { found: false },
      );
    }
  });

  it.each(["printed", "creation", "operation"] as const)(
    "joins standalone %s on interruption",
    async (phase) => {
      const signal = phase === "printed" ? "SIGTERM" : "SIGINT";
      const originalListeners = new Set(process.listeners(signal));
      const originalExitCode = process.exitCode;
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stopping = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      const pause = async () => {
        ready.resolve();
        await release.promise;
      };
      const stop = vi.fn(async () => {
        stopping.resolve();
        await stopped.promise;
      });
      const initiateCall = vi.fn(async () => {
        if (phase === "operation") {
          await pause();
        }
        return { success: true, callId: "call-owned" };
      });
      const ensureRuntime = async () => {
        if (phase === "creation") {
          await pause();
        }
        return { config: { toNumber: "+15550001234" }, manager: { initiateCall }, stop } as never;
      };
      const capturer = captureStdout((output) => {
        if (phase === "printed" && output.includes("call-owned")) {
          ready.resolve();
        }
      });
      callGatewayFromCliMock.mockRejectedValue(gatewayTransportError());
      const command = runCli(buildProgram({}, {}, ensureRuntime), ["call", "--message", "hello"]);
      let completed = false;
      const outcome = command.then(
        () => {
          completed = true;
        },
        (error: unknown) => error,
      );
      const handlers = () => process.listeners(signal).filter((fn) => !originalListeners.has(fn));
      try {
        await ready.promise;
        expect(handlers()).toHaveLength(1);
        handlers()[0]?.(signal);
        if (phase === "printed") {
          expect(JSON.parse(capturer())).toEqual({ callId: "call-owned" });
          handlers()[0]?.(signal);
        } else {
          expect(stop).not.toHaveBeenCalled();
        }
        release.resolve();
        await stopping.promise;
        expect(completed).toBe(false);
        expect(stop).toHaveBeenCalledOnce();
        stopped.resolve();
        const result = await outcome;
        expect(stop).toHaveBeenCalledOnce();
        if (phase === "creation") {
          expect(result).toMatchObject({ message: "Voice call command interrupted by SIGINT" });
          expect(initiateCall).not.toHaveBeenCalled();
        } else {
          expect(result).toBeUndefined();
          expect(initiateCall).toHaveBeenCalledOnce();
        }
        expect(process.listeners(signal)).toEqual([...originalListeners]);
        expect(process.exitCode).toBe(signal === "SIGTERM" ? 143 : 130);
      } finally {
        for (const handler of handlers()) {
          handler(signal);
        }
        release.resolve();
        stopped.resolve();
        await outcome;
        process.exitCode = originalExitCode;
      }
    },
  );

  it("explains a standalone webhook port collision", async () => {
    callGatewayFromCliMock.mockRejectedValue(gatewayTransportError());
    const ensureRuntime = vi.fn(async () => {
      throw Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
    });
    const program = buildProgram({}, { serve: { port: 3334 } }, ensureRuntime);

    await expect(runCli(program, ["call", "--message", "hello"])).rejects.toThrow(
      "Voice-call webhook port 3334 is already in use. A running Gateway probably already serves it",
    );
  });

  it.each([
    [
      "reachable request",
      ["call", "--message", "hello"],
      "Voice call runtime generation is retired; use the current registration",
    ],
    ["missing continue method", continueArgs, "unknown method: voicecall.continue.start"],
    ["credential", ["status", "--json"], "gateway voicecall.status requires credentials"],
  ] as const)("keeps %s failures out of the standalone runtime", async (name, args, detail) => {
    const credential = name === "credential";
    const error = credential ? gatewayCredentialsError(detail) : gatewayRequestError(detail);
    callGatewayFromCliMock.mockRejectedValue(error);
    const ensureRuntime = vi.fn();
    await expect(runCli(buildProgram({}, {}, ensureRuntime), [...args])).rejects.toThrow(
      `${credential ? "Gateway requires credentials" : "Gateway responded but voicecall failed"}: ${detail}`,
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(callGatewayFromCliMock).toHaveBeenCalledOnce();
    if (credential) {
      expect(loadActiveCallsFromStoreMock).not.toHaveBeenCalled();
    }
  });

  it("redacts credential-bearing gateway URLs from operational errors", async () => {
    callGatewayFromCliMock.mockRejectedValue(
      gatewayTransportError(
        1008,
        "wss://operator:hunter2secret@gw.example.ts.net:18789?token=tok123",
        "gateway closed (1008): policy wss://operator:hunter2secret@gw.example.ts.net:18789",
      ),
    );
    const ensureRuntime = vi.fn();
    const thrown: unknown = await runCli(buildProgram({}, {}, ensureRuntime), [
      "status",
      "--json",
    ]).catch((err: unknown) => err);
    const text = thrown instanceof Error ? thrown.message : String(thrown);
    expect(text).toContain("Gateway connection at wss://***:***@gw.example.ts.net:18789");
    expect(text).not.toContain("hunter2secret");
    expect(text).not.toContain("tok123");
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("rejects non-decimal tail options through the registered command", async () => {
    await expect(run(["tail", "--since", "0x10"])).rejects.toThrow(
      "Invalid numeric value for --since: 0x10",
    );
  });

  function exposureConfig(streaming = true) {
    return {
      serve: { port: 3334, path: "/voice/webhook" },
      tailscale: { mode: "off", port: 443, path: "/voice/webhook" },
      realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
      streaming: streaming ? { enabled: true, streamPath: "/voice/stream" } : { enabled: false },
    };
  }

  it("exposes the webhook target and enabled stream paths", async () => {
    tailscaleMocks.setup.mockResolvedValue("https://bot.example.ts.net/voice/webhook");
    const output = await capture(
      commandArgs("expose", {
        mode: "funnel",
        port: "4444",
        path: "/edge/custom/webhook",
        "serve-path": "/custom/webhook",
      }),
      exposureConfig(),
    );

    expect(tailscaleMocks.setup).toHaveBeenCalledWith({
      mode: "funnel",
      port: 443,
      routes: [
        ["/edge/custom/webhook", "/custom/webhook"],
        ["/edge/voice/stream/realtime", "/voice/stream/realtime"],
        ["/voice/stream", "/voice/stream"],
      ].map(([route, local]) => ({ path: route, localUrl: `http://127.0.0.1:4444${local}` })),
    });
    expect(output).toMatchObject({
      localUrl: "http://127.0.0.1:4444/custom/webhook",
      streamPaths: ["/edge/voice/stream/realtime", "/voice/stream"],
    });
  });

  it("reports failure when any exposure route cannot be mounted", async () => {
    tailscaleMocks.setup.mockResolvedValue(null);
    tailscaleMocks.getSelfInfo.mockResolvedValue(null);
    expect(await capture(["expose", "--mode", "funnel"], exposureConfig(false))).toMatchObject({
      ok: false,
      publicUrl: null,
    });
  });

  it("clears webhook and stream paths for both Tailscale modes", async () => {
    const output = await capture(["expose", "--mode", "off"], exposureConfig());

    expect(tailscaleMocks.cleanup.mock.calls).toEqual(
      ["/voice/webhook", "/voice/stream/realtime", "/voice/stream"].flatMap((exposurePath) => [
        [{ mode: "serve", port: 443, path: exposurePath }],
        [{ mode: "funnel", port: 443, path: exposurePath }],
      ]),
    );
    expect(output).toMatchObject({
      mode: "off",
      streamPaths: ["/voice/stream/realtime", "/voice/stream"],
    });
  });

  async function runCustomLogTailShortRead(
    appended: string,
    firstReadBytes: number,
    copyTruncated?: string,
  ): Promise<{ output: string; shortened: boolean }> {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-tail-"));
    const logFile = path.join(tempDir, "custom.log");
    const initial = "initial\n";
    fs.writeFileSync(logFile, initial);
    const initialByteLength = Buffer.byteLength(initial);

    const sentinel = new Error("stop voice-call tail test");
    const capturer = captureStdout();
    const originalReadSync = fs.readSync.bind(fs);
    let shortened = false;
    const readSyncSpy = vi.spyOn(fs, "readSync");
    readSyncSpy.mockImplementation(((fd, buffer, offset, length, position) => {
      if (
        !shortened &&
        typeof position === "number" &&
        position === initialByteLength &&
        Buffer.isBuffer(buffer)
      ) {
        shortened = true;
        return originalReadSync(fd, buffer, offset, firstReadBytes, position);
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);

    sleepMock
      .mockImplementationOnce(async () => {
        fs.appendFileSync(logFile, appended);
      })
      .mockImplementationOnce(async () => {
        if (copyTruncated !== undefined) {
          fs.writeFileSync(logFile, copyTruncated);
        }
      })
      .mockImplementationOnce(async () => {
        throw sentinel;
      });

    try {
      await expect(run(["tail", "--file", logFile, "--since", "0", "--poll", "50"])).rejects.toBe(
        sentinel,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { output: capturer(), shortened };
  }

  const firstRecord = '{"event":"first"}\n';
  const secondRecord = '{"event":"second"}\n';
  it.each([
    ["newline", "first\nsecond\n", 6, undefined],
    ["mid-record", firstRecord + secondRecord, 13, '{"event":"fir\n'],
  ] as const)("buffers custom log tail %s", async (_name, appended, bytes, excludes) => {
    const result = await runCustomLogTailShortRead(appended, bytes);
    expect(result.shortened).toBe(true);
    expect(result.output).toContain(appended);
    if (excludes !== undefined) {
      expect(result.output).not.toContain(excludes);
    }
  });

  it("resets short-read text and UTF-8 state when a custom log is copy-truncated", async () => {
    const initial = "initial\n";
    const appended = '{"event":"staleé-with-more-observed-bytes"}\n';
    const replacement = '{"event":"fresh-start-full"}\n';
    const firstReadBytes = Buffer.byteLength('{"event":"stale', "utf8") + 1;
    const shortReadCursor = Buffer.byteLength(initial, "utf8") + firstReadBytes;

    expect(Buffer.byteLength(replacement)).toBeGreaterThan(shortReadCursor);
    expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(initial + appended));

    const result = await runCustomLogTailShortRead(appended, firstReadBytes, replacement);

    expect(result).toEqual({ shortened: true, output: replacement });
  });

  it("passes a structured brief and routes steering through the Gateway", async () => {
    callGatewayFromCliMock.mockResolvedValue({ callId: "call-1", success: true });
    await capture(
      commandArgs("call", {
        message: "Hello",
        to: "+15550001111",
        brief: '{"task":"Arrange a visit"}',
      }),
      { ringTimeoutMs: 1000 },
    );
    expect(callGatewayFromCliMock.mock.calls[0]?.[2]).toMatchObject({
      brief: { task: "Arrange a visit" },
    });
    await capture(
      commandArgs("steer", { "call-id": "call-1", message: "Tuesday", mode: "guidance" }),
    );
    expect(callGatewayFromCliMock).toHaveBeenLastCalledWith(
      "voicecall.steer",
      expect.anything(),
      { callId: "call-1", message: "Tuesday", mode: "guidance" },
      expect.anything(),
    );
  });

  function pendingContinue(pollTimeoutMs: number) {
    return callGatewayFromCliMock.mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
      pollTimeoutMs,
    });
  }
  const continueTimeout = "voicecall continue timed out waiting for gateway operation";

  it("caps oversized operation timeouts through the start command", async () => {
    callGatewayFromCliMock.mockResolvedValue({ callId: "call-1" });
    await run(["start", "--to", "+15550001111"], { ringTimeoutMs: Number.MAX_SAFE_INTEGER });
    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "voicecall.start",
      { json: true, timeout: String(MAX_TIMER_TIMEOUT_MS) },
      { to: "+15550001111", mode: "conversation" },
      { progress: false },
    );
  });

  it("uses the configured continue deadline when the gateway poll timeout is non-finite", async () => {
    pendingContinue(Number.NaN);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(50_000);
    await expect(run(continueArgs, { transcriptTimeoutMs: 100 })).rejects.toThrow(continueTimeout);
    expect(callGatewayFromCliMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a withheld continue.result RPC to the overall poll deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pendingContinue(1_500)
      .mockResolvedValueOnce({ status: "pending" })
      .mockImplementationOnce(
        async (_method: string, opts: { timeout: string }) =>
          await new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error(`gateway timeout after ${opts.timeout}ms`)),
              Number(opts.timeout),
            );
          }),
      );

    const startedAtMs = Date.now();
    const execution = run(continueArgs, { transcriptTimeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(callGatewayFromCliMock).toHaveBeenNthCalledWith(
      3,
      "voicecall.continue.result",
      { json: true, timeout: "500" },
      { operationId: "op-1" },
      { progress: false },
    );
    const rejected = expect(execution).rejects.toThrow("gateway timeout after 500ms");
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(Date.now() - startedAtMs).toBe(1_500);
  });

  it("keeps the continue poll deadline on the monotonic clock across a wall-clock jump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    pendingContinue(5_000).mockResolvedValue({ status: "pending" });

    const execution = run(continueArgs, { transcriptTimeoutMs: 100 });

    // Seed the monotonic deadline and complete the first poll/sleep.
    await vi.advanceTimersByTimeAsync(1_000);

    // An NTP/resume wall-clock jump must not exhaust the monotonic budget.
    const wallClockSpy = vi.spyOn(Date, "now").mockReturnValue(300_000);
    await vi.advanceTimersByTimeAsync(1_000);

    // The pre-fix wall-clock deadline settled here; the monotonic poll stays pending.
    const settled = await Promise.race([
      execution.then(
        () => "resolved",
        () => "rejected",
      ),
      Promise.resolve("pending" as const),
    ]);
    expect(settled).toBe("pending");
    expect(callGatewayFromCliMock).toHaveBeenCalledTimes(4);
    wallClockSpy.mockRestore();

    // Draining the remaining monotonic budget (5000ms) finally times out.
    const rejected = expect(execution).rejects.toThrow(continueTimeout);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
  });
});
