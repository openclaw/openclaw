// Voice Call tests cover cli plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() =>
  vi.fn(
    (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  ),
);
const tempDirs = new Set<string>();

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  sleep: sleepMock,
}));

import { registerVoiceCallCli } from "./cli.js";

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

describe("voice-call CLI status fallback", () => {
  afterEach(() => {
    callGatewayFromCliMock.mockReset();
    sleepMock.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildProgram(
    manager: Record<string, unknown>,
    config: Record<string, unknown> = {},
  ): Command {
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: config as never,
      ensureRuntime: async () => ({ manager }) as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    return program;
  }

  async function runStatusWithUnavailableGateway(
    manager: Record<string, unknown>,
    error = new Error("connect ECONNREFUSED 127.0.0.1:18789"),
  ): Promise<unknown> {
    callGatewayFromCliMock.mockRejectedValue(error);
    const program = buildProgram(manager);
    const capturer = captureStdout();
    try {
      await program.parseAsync(["voicecall", "status", "--call-id", "call-1", "--json"], {
        from: "user",
      });
    } finally {
      capturer.restore();
    }
    return JSON.parse(capturer.output().trim());
  }

  it("uses the manager's persisted fallback when the gateway is unavailable", async () => {
    const result = await runStatusWithUnavailableGateway({
      getActiveCalls: () => [],
      getCallFromMemoryOrStore: async () => ({
        callId: "call-1",
        providerCallId: "CA123",
        state: "completed",
        endReason: "completed",
        endedAt: 1,
      }),
    });
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("reports found:false when the call is neither active nor persisted", async () => {
    const result = await runStatusWithUnavailableGateway({
      getActiveCalls: () => [],
      getCallFromMemoryOrStore: async () => undefined,
    });
    expect(result).toEqual({ found: false });
  });

  it("falls back after an abnormal local gateway close", async () => {
    const result = await runStatusWithUnavailableGateway(
      {
        getActiveCalls: () => [],
        getCallFromMemoryOrStore: async () => ({ callId: "call-1", state: "completed" }),
      },
      new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
    );
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("rejects non-decimal tail options through the registered command", async () => {
    const program = buildProgram({});
    await expect(
      program.parseAsync(["voicecall", "tail", "--since", "0x10"], { from: "user" }),
    ).rejects.toThrow("Invalid numeric value for --since: 0x10");
  });

  it("drops a partial leading JSONL record from capped diagnostic reads", async () => {
    const tempRoot = makeTempDir("openclaw-voice-call-cli-");
    const file = path.join(tempRoot, "diagnostics.jsonl");
    const completeRecords = [
      JSON.stringify({ call: { metadata: { lastTurnLatencyMs: 120 } } }),
      JSON.stringify({ call: { metadata: { lastTurnLatencyMs: 240 } } }),
    ];
    const crossingRecord = JSON.stringify({ padding: "x".repeat(1_000_000) });
    writeFileSync(file, [crossingRecord, ...completeRecords].join("\n") + "\n", "utf8");

    const latencyProgram = buildProgram({});
    const latencyOutput = captureStdout();
    try {
      await latencyProgram.parseAsync(["voicecall", "latency", "--file", file], {
        from: "user",
      });
    } finally {
      latencyOutput.restore();
    }
    expect(JSON.parse(latencyOutput.output())).toMatchObject({
      recordsScanned: 2,
      turnLatency: { count: 2 },
    });

    sleepMock.mockRejectedValueOnce(new Error("stop tail after initial output"));
    const tailProgram = buildProgram({});
    const tailOutput = captureStdout();
    try {
      await expect(
        tailProgram.parseAsync(["voicecall", "tail", "--file", file, "--since", "10"], {
          from: "user",
        }),
      ).rejects.toThrow("stop tail after initial output");
    } finally {
      tailOutput.restore();
    }
    expect(tailOutput.output().trim().split("\n")).toEqual(completeRecords);
  });

  it("caps oversized operation timeouts through the start command", async () => {
    callGatewayFromCliMock.mockResolvedValue({ callId: "call-1" });
    const program = buildProgram({}, { ringTimeoutMs: Number.MAX_SAFE_INTEGER });
    await program.parseAsync(["voicecall", "start", "--to", "+15550001111"], {
      from: "user",
    });
    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "voicecall.start",
      { json: true, timeout: String(MAX_TIMER_TIMEOUT_MS) },
      { to: "+15550001111", mode: "conversation" },
      { progress: false },
    );
  });

  it("caps oversized legacy continue timeouts through the command", async () => {
    callGatewayFromCliMock
      .mockRejectedValueOnce(new Error("unknown method: voicecall.continue.start"))
      .mockResolvedValueOnce({ success: true, transcript: "done" });
    const program = buildProgram({}, { transcriptTimeoutMs: Number.MAX_SAFE_INTEGER });
    await program.parseAsync(
      ["voicecall", "continue", "--call-id", "call-1", "--message", "hello"],
      { from: "user" },
    );
    expect(callGatewayFromCliMock).toHaveBeenLastCalledWith(
      "voicecall.continue",
      { json: true, timeout: String(MAX_TIMER_TIMEOUT_MS) },
      { callId: "call-1", message: "hello" },
      { progress: false },
    );
  });

  it("uses the configured continue deadline when the gateway poll timeout is non-finite", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
      pollTimeoutMs: Number.NaN,
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(50_000);
    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    await expect(
      program.parseAsync(["voicecall", "continue", "--call-id", "call-1", "--message", "hello"], {
        from: "user",
      }),
    ).rejects.toThrow("voicecall continue timed out waiting for gateway operation");
    expect(callGatewayFromCliMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a withheld continue.result RPC to the overall poll deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    callGatewayFromCliMock
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "pending",
        pollTimeoutMs: 1_500,
      })
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
    const execution = program.parseAsync(
      ["voicecall", "continue", "--call-id", "call-1", "--message", "hello"],
      { from: "user" },
    );

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
});
