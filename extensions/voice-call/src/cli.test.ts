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
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    onOutput?.(output);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function runCli(program: Command, args: string[]) {
  return program.parseAsync(["voicecall", ...args], { from: "user" });
}

async function captureCli(program: Command, args: string[]) {
  const capture = captureStdout();
  try {
    await runCli(program, args);
    return capture.output();
  } finally {
    capture.restore();
  }
}

const continueArgs = ["continue", "--call-id", "call-1", "--message", "hello"];

function gatewayTransportError(code?: number): Error {
  return Object.assign(new Error("gateway transport failed"), {
    name: "GatewayTransportError",
    kind: "closed",
    connectionDetails: { url: "ws://127.0.0.1:18789" },
    ...(code === undefined ? {} : { code }),
  });
}

function gatewayRequestError(message: string, gatewayCode = "UNAVAILABLE"): Error {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode,
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

  async function withStandalone(
    signal: "SIGINT" | "SIGTERM",
    ensureRuntime: Parameters<typeof buildProgram>[2],
    check: (command: ReturnType<typeof runCli>, interrupt: () => void) => Promise<void>,
    onOutput?: (output: string) => void,
    release = () => {},
  ) {
    callGatewayFromCliMock.mockRejectedValue(gatewayTransportError());
    const originalListeners = new Set(process.listeners(signal));
    const originalExitCode = process.exitCode;
    const capturer = captureStdout(onOutput);
    const command = runCli(buildProgram({}, {}, ensureRuntime), ["call", "--message", "hello"]);
    const outcome = command.then(
      () => {},
      () => {},
    );
    const handlers = () => process.listeners(signal).filter((fn) => !originalListeners.has(fn));
    try {
      await check(command, () => {
        expect(handlers()).toHaveLength(1);
        handlers()[0]?.(signal);
      });
      release();
      await (signal === "SIGTERM" ? command : outcome);
      expect(process.listeners(signal)).toEqual([...originalListeners]);
      expect(process.exitCode).toBe(signal === "SIGTERM" ? 143 : 130);
    } finally {
      for (const handler of handlers()) {
        handler(signal);
      }
      release();
      await outcome;
      capturer.restore();
      process.exitCode = originalExitCode;
    }
  }

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

  async function runStatusWithUnavailableGateway(params: {
    persisted?: unknown;
    error?: Error;
    args?: string[];
  }): Promise<unknown> {
    callGatewayFromCliMock.mockRejectedValue(params.error ?? gatewayTransportError());
    findCallInStoreMock.mockResolvedValue(params.persisted);
    const ensureRuntime = vi.fn(async () => {
      throw new Error("status fallback must not initialize the telephony runtime");
    });
    const program = buildProgram({}, {}, ensureRuntime, { stateRuntime: {} as never });
    const output = await captureCli(program, [
      "status",
      ...(params.args ?? ["--call-id", "call-1"]),
      "--json",
    ]);
    expect(ensureRuntime).not.toHaveBeenCalled();
    return JSON.parse(output);
  }

  it.each([undefined, 1006])("uses persisted status after gateway close %s", async (code) => {
    const persisted = { callId: "call-1", state: "completed" };
    expect(
      await runStatusWithUnavailableGateway({ persisted, error: gatewayTransportError(code) }),
    ).toMatchObject(persisted);
  });

  it("reports found:false when the call is neither active nor persisted", async () => {
    expect(await runStatusWithUnavailableGateway({})).toEqual({ found: false });
  });

  it("lists persisted active calls without initializing the telephony runtime", async () => {
    loadActiveCallsFromStoreMock.mockResolvedValue({
      activeCalls: new Map([["call-1", { callId: "call-1", state: "ringing" }]]),
    });
    expect(await runStatusWithUnavailableGateway({ args: [] })).toEqual({
      found: true,
      calls: [{ callId: "call-1", state: "ringing" }],
    });
  });

  it("keeps standalone serving after printing the call ID and joins signal cleanup", async () => {
    let output = "";
    const printed = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const stop = vi.fn(async () => {
      stopping.resolve();
      await stopped.promise;
    });
    await withStandalone(
      "SIGTERM",
      async () =>
        ({
          config: { toNumber: "+15550001234" },
          manager: { initiateCall: async () => ({ success: true, callId: "call-owned" }) },
          stop,
        }) as never,
      async (command, interrupt) => {
        let completed = false;
        void command.then(
          () => {
            completed = true;
          },
          () => {},
        );
        await printed.promise;
        expect(JSON.parse(output)).toEqual({ callId: "call-owned" });
        interrupt();
        interrupt();
        await stopping.promise;
        expect(completed).toBe(false);
        expect(stop).toHaveBeenCalledOnce();
      },
      (written) => {
        output = written;
        if (written.includes("call-owned")) {
          printed.resolve();
        }
      },
      stopped.resolve,
    );
  });

  it.each(["creation", "operation"] as const)(
    "joins accepted standalone %s when interrupted",
    async (phase) => {
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stop = vi.fn(async () => {});
      const initiateCall = vi.fn(async () => {
        ready.resolve();
        await release.promise;
        return { success: true, callId: "call-owned" };
      });
      await withStandalone(
        "SIGINT",
        async () => {
          if (phase === "creation") {
            ready.resolve();
            await release.promise;
          }
          return { config: { toNumber: "+15550001234" }, manager: { initiateCall }, stop } as never;
        },
        async (command, interrupt) => {
          const outcome = command.then(
            () => undefined,
            (error: unknown) => error,
          );
          await ready.promise;
          interrupt();
          expect(stop).not.toHaveBeenCalled();
          release.resolve();
          const result = await outcome;
          if (phase === "creation") {
            expect(result).toMatchObject({ message: "Voice call command interrupted by SIGINT" });
            expect(initiateCall).not.toHaveBeenCalled();
          } else {
            expect(result).toBeUndefined();
            expect(initiateCall).toHaveBeenCalledOnce();
          }
          expect(stop).toHaveBeenCalledOnce();
        },
        undefined,
        release.resolve,
      );
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
    {
      name: "reachable request",
      error: gatewayRequestError(
        "Voice call runtime generation is retired; use the current registration",
      ),
      args: ["call", "--message", "hello"],
      message:
        "Gateway responded but voicecall failed: Voice call runtime generation is retired; use the current registration",
    },
    {
      name: "missing continue method",
      error: gatewayRequestError("unknown method: voicecall.continue.start"),
      args: continueArgs,
      message: "Gateway responded but voicecall failed: unknown method: voicecall.continue.start",
    },
    {
      name: "credential",
      error: gatewayCredentialsError("gateway voicecall.status requires credentials"),
      args: ["status", "--json"],
      message: "Gateway requires credentials: gateway voicecall.status requires credentials",
    },
  ])(
    "keeps $name failures out of the standalone runtime",
    async ({ name, error, args, message }) => {
      callGatewayFromCliMock.mockRejectedValue(error);
      const ensureRuntime = vi.fn();
      await expect(runCli(buildProgram({}, {}, ensureRuntime), args)).rejects.toThrow(message);
      expect(ensureRuntime).not.toHaveBeenCalled();
      expect(callGatewayFromCliMock).toHaveBeenCalledOnce();
      if (name === "credential") {
        expect(loadActiveCallsFromStoreMock).not.toHaveBeenCalled();
      }
    },
  );

  it("redacts credential-bearing gateway URLs from operational errors", async () => {
    callGatewayFromCliMock.mockRejectedValue(
      Object.assign(
        new Error(
          "gateway closed (1008): policy wss://operator:hunter2secret@gw.example.ts.net:18789",
        ),
        {
          name: "GatewayTransportError",
          kind: "closed",
          code: 1008,
          connectionDetails: {
            url: "wss://operator:hunter2secret@gw.example.ts.net:18789?token=tok123",
          },
        },
      ),
    );
    const ensureRuntime = vi.fn();
    const program = buildProgram({}, {}, ensureRuntime);

    const thrown: unknown = await runCli(program, ["status", "--json"]).catch(
      (err: unknown) => err,
    );
    const text = thrown instanceof Error ? thrown.message : String(thrown);
    expect(text).toContain("Gateway connection at wss://***:***@gw.example.ts.net:18789");
    expect(text).not.toContain("hunter2secret");
    expect(text).not.toContain("tok123");
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("rejects non-decimal tail options through the registered command", async () => {
    const program = buildProgram({});
    await expect(runCli(program, ["tail", "--since", "0x10"])).rejects.toThrow(
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
    const program = buildProgram({}, exposureConfig());
    const output = await captureCli(program, [
      "expose",
      "--mode",
      "funnel",
      "--port",
      "4444",
      "--path",
      "/edge/custom/webhook",
      "--serve-path",
      "/custom/webhook",
    ]);

    expect(tailscaleMocks.setup).toHaveBeenCalledWith({
      mode: "funnel",
      port: 443,
      routes: [
        ["/edge/custom/webhook", "/custom/webhook"],
        ["/edge/voice/stream/realtime", "/voice/stream/realtime"],
        ["/voice/stream", "/voice/stream"],
      ].map(([route, local]) => ({ path: route, localUrl: `http://127.0.0.1:4444${local}` })),
    });
    expect(JSON.parse(output)).toMatchObject({
      localUrl: "http://127.0.0.1:4444/custom/webhook",
      streamPaths: ["/edge/voice/stream/realtime", "/voice/stream"],
    });
  });

  it("reports failure when any exposure route cannot be mounted", async () => {
    tailscaleMocks.setup.mockResolvedValue(null);
    tailscaleMocks.getSelfInfo.mockResolvedValue(null);
    const program = buildProgram({}, exposureConfig(false));
    const output = await captureCli(program, ["expose", "--mode", "funnel"]);

    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      publicUrl: null,
    });
  });

  it("clears webhook and stream paths for both Tailscale modes", async () => {
    const program = buildProgram({}, exposureConfig());
    const output = await captureCli(program, ["expose", "--mode", "off"]);

    expect(tailscaleMocks.cleanup.mock.calls).toEqual(
      ["/voice/webhook", "/voice/stream/realtime", "/voice/stream"].flatMap((exposurePath) => [
        [{ mode: "serve", port: 443, path: exposurePath }],
        [{ mode: "funnel", port: 443, path: exposurePath }],
      ]),
    );
    expect(JSON.parse(output)).toMatchObject({
      mode: "off",
      streamPaths: ["/voice/stream/realtime", "/voice/stream"],
    });
  });

  async function runCustomLogTailShortRead(
    appended: string | Buffer,
    firstReadBytes?: number,
    initial: string | Buffer = "initial\n",
    copyTruncated?: string | Buffer,
  ): Promise<{ output: string; shortened: boolean }> {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-tail-"));
    const logFile = path.join(tempDir, "custom.log");
    fs.writeFileSync(logFile, initial);
    const initialByteLength = Buffer.isBuffer(initial)
      ? initial.length
      : Buffer.byteLength(initial, "utf8");

    const sentinel = new Error("stop voice-call tail test");
    const capturer = captureStdout();
    const originalReadSync = fs.readSync.bind(fs);
    const readSyncSpy = vi.spyOn(fs, "readSync");
    let shortened = false;

    readSyncSpy.mockImplementation(((fd, buffer, offset, length, position) => {
      if (
        !shortened &&
        firstReadBytes !== undefined &&
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
      const program = buildProgram({});
      await expect(
        runCli(program, ["tail", "--file", logFile, "--since", "0", "--poll", "50"]),
      ).rejects.toBe(sentinel);
    } finally {
      capturer.restore();
      readSyncSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { output: capturer.output(), shortened };
  }

  const partialUtf8 = Buffer.from('{"word":"café"}\n');
  const utf8Split = Buffer.byteLength('{"word":"caf') + 1;
  const firstRecord = '{"event":"first"}\n';
  const secondRecord = '{"event":"second"}\n';
  it.each([
    ["newline", "first\nsecond\n", 6, undefined, undefined],
    ["mid-record", firstRecord + secondRecord, 13, '{"event":"fir\n', undefined],
    ["UTF-8", partialUtf8, utf8Split, "\ufffd", undefined],
    ["startup record", 'rt"}\n', undefined, '{"event":"sta\n', '{"event":"sta'],
    [
      "startup UTF-8",
      partialUtf8.subarray(utf8Split),
      undefined,
      "\ufffd",
      partialUtf8.subarray(0, utf8Split),
    ],
  ] as const)("buffers custom log tail %s", async (_name, appended, bytes, excludes, initial) => {
    const result = await runCustomLogTailShortRead(appended, bytes, initial);
    expect(result.shortened).toBe(bytes !== undefined);
    const expected = Buffer.concat([Buffer.from(initial ?? ""), Buffer.from(appended)]).toString();
    expect(result.output).toContain(expected);
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

    expect(Buffer.byteLength(replacement, "utf8")).toBeGreaterThan(shortReadCursor);
    expect(Buffer.byteLength(replacement, "utf8")).toBeLessThan(
      Buffer.byteLength(initial, "utf8") + Buffer.byteLength(appended, "utf8"),
    );

    const result = await runCustomLogTailShortRead(appended, firstReadBytes, initial, replacement);

    expect(result).toEqual({ shortened: true, output: replacement });
  });

  it("passes a structured brief and routes steering through the Gateway", async () => {
    callGatewayFromCliMock.mockResolvedValue({ callId: "call-1", success: true });
    const program = buildProgram({}, { ringTimeoutMs: 1000 });
    await captureCli(program, [
      "call",
      "--message",
      "Hello",
      "--to",
      "+15550001111",
      "--brief",
      '{"task":"Arrange a visit"}',
    ]);
    expect(callGatewayFromCliMock.mock.calls[0]?.[2]).toMatchObject({
      brief: { task: "Arrange a visit" },
    });
    await captureCli(program, [
      "steer",
      "--call-id",
      "call-1",
      "--message",
      "Tuesday",
      "--mode",
      "guidance",
    ]);
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
    const program = buildProgram({}, { ringTimeoutMs: Number.MAX_SAFE_INTEGER });
    await runCli(program, ["start", "--to", "+15550001111"]);
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
    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    await expect(runCli(program, continueArgs)).rejects.toThrow(continueTimeout);
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

    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    const startedAtMs = Date.now();
    const execution = runCli(program, continueArgs);

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

    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    const execution = runCli(program, continueArgs);

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
