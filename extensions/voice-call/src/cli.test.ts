import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Voice Call tests cover cli plugin behavior.
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() =>
  vi.fn(
    async (ms: number) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  ),
);
const tempDirs = new Set<string>();

function makeTempDir(prefix: string) {
  // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
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
    sleepMock.mockReset();
    sleepMock.mockImplementation(
      async (ms: number) =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    );
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
    let output = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const originalReadSync = fs.readSync.bind(fs);
    const readSyncSpy = vi.spyOn(fs, "readSync");
    let shortened = false;

    readSyncSpy.mockImplementation(((fd, buffer, offset, length, position) => {
      if (
        shortened &&
        copyTruncated !== undefined &&
        typeof position === "number" &&
        position === initialByteLength + (firstReadBytes ?? 0)
      ) {
        return 0;
      }
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
        program.parseAsync(
          ["voicecall", "tail", "--file", logFile, "--since", "0", "--poll", "50"],
          {
            from: "user",
          },
        ),
      ).rejects.toBe(sentinel);
    } finally {
      stdoutSpy.mockRestore();
      readSyncSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { output, shortened };
  }

  it("keeps custom log tail follow offset aligned with newline short reads", async () => {
    const result = await runCustomLogTailShortRead(
      "first\nsecond\n",
      Buffer.byteLength("first\n", "utf8"),
    );

    expect(result.shortened).toBe(true);
    expect(result.output).toContain("first\n");
    expect(result.output).toContain("second\n");
  });

  it("buffers custom log tail records across mid-record short reads", async () => {
    const result = await runCustomLogTailShortRead(
      '{"event":"first"}\n{"event":"second"}\n',
      Buffer.byteLength('{"event":"fir', "utf8"),
    );

    expect(result.shortened).toBe(true);
    expect(result.output).not.toContain('{"event":"fir\n');
    expect(result.output).toContain('{"event":"first"}\n');
    expect(result.output).toContain('{"event":"second"}\n');
  });

  it("buffers custom log tail UTF-8 characters across short reads", async () => {
    const result = await runCustomLogTailShortRead(
      '{"word":"café"}\n',
      Buffer.byteLength('{"word":"caf', "utf8") + 1,
    );

    expect(result.shortened).toBe(true);
    expect(result.output).not.toContain("\ufffd");
    expect(result.output).toContain('{"word":"café"}\n');
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

    expect(result.shortened).toBe(true);
    expect(result.output).toBe(replacement);
  });

  it("buffers custom log tail records that are partial at startup", async () => {
    const result = await runCustomLogTailShortRead('rt"}\n', undefined, '{"event":"sta');

    expect(result.shortened).toBe(false);
    expect(result.output).not.toContain('{"event":"sta\n');
    expect(result.output).toContain('{"event":"start"}\n');
  });

  it("buffers custom log tail UTF-8 characters that are partial at startup", async () => {
    const prefix = Buffer.from('{"word":"caf', "utf8");
    const eAcute = Buffer.from("é", "utf8");
    const initial = Buffer.concat([prefix, eAcute.subarray(0, 1)]);
    const suffix = Buffer.concat([eAcute.subarray(1), Buffer.from('"}\n', "utf8")]);
    const result = await runCustomLogTailShortRead(suffix, undefined, initial);

    expect(result.shortened).toBe(false);
    expect(result.output).not.toContain("\ufffd");
    expect(result.output).toContain('{"word":"café"}\n');
  });

  it("drops a partial leading JSONL record from capped diagnostic reads", async () => {
    const tempRoot = makeTempDir("openclaw-voice-call-cli-");
    const file = path.join(tempRoot, "diagnostics.jsonl");
    const completeRecords = [
      JSON.stringify({ call: { metadata: { lastTurnLatencyMs: 120 } } }),
      JSON.stringify({ call: { metadata: { lastTurnLatencyMs: 240 } } }),
    ];
    const crossingRecord = JSON.stringify({ padding: "x".repeat(1_000_000) });
    fs.writeFileSync(file, [crossingRecord, ...completeRecords].join("\n") + "\n", "utf8");

    try {
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
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads follow-up appends in bounded chunks and retains a partial final record", async () => {
    const tempRoot = makeTempDir("openclaw-voice-call-cli-follow-");
    const file = path.join(tempRoot, "diagnostics.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ seq: 0 })}\n`, "utf8");
    const appendedRecords = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ seq: index + 1, padding: "x".repeat(550) }),
    );

    sleepMock
      .mockImplementationOnce(async () => {
        fs.appendFileSync(
          file,
          `${appendedRecords.join("\n")}\n${JSON.stringify({ seq: 2001 }).slice(0, -2)}`,
        );
      })
      .mockImplementationOnce(async () => {
        fs.appendFileSync(file, "1}\n");
      })
      .mockRejectedValueOnce(new Error("stop tail after follow-up output"));

    const program = buildProgram({});
    const output = captureStdout();
    try {
      await expect(
        program.parseAsync(["voicecall", "tail", "--file", file, "--since", "1"], {
          from: "user",
        }),
      ).rejects.toThrow("stop tail after follow-up output");
    } finally {
      output.restore();
    }

    const lines = output.output().trim().split("\n");
    expect(lines).toHaveLength(2_002);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ seq: 0 });
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual({ seq: 2001 });
  });

  it("preserves a UTF-8 code point split across follow read chunks", async () => {
    const tempRoot = makeTempDir("openclaw-voice-call-cli-utf8-");
    const file = path.join(tempRoot, "diagnostics.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ seq: 0 })}\n`, "utf8");
    const recordPrefix = '{"seq":1,"text":"';
    const text = `${"x".repeat(64 * 1024 - 1 - Buffer.byteLength(recordPrefix))}中`;
    const record = `${recordPrefix}${text}"}`;

    sleepMock
      .mockImplementationOnce(async () => {
        fs.appendFileSync(file, `${record}\n`, "utf8");
      })
      .mockRejectedValueOnce(new Error("stop tail after UTF-8 boundary output"));

    const program = buildProgram({});
    const output = captureStdout();
    try {
      await expect(
        program.parseAsync(["voicecall", "tail", "--file", file, "--since", "1"], {
          from: "user",
        }),
      ).rejects.toThrow("stop tail after UTF-8 boundary output");
    } finally {
      output.restore();
    }

    const lines = output.output().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toEqual({ seq: 1, text });
  });

  it("clears pending follow state when a larger replacement changes file identity", async () => {
    const tempRoot = makeTempDir("openclaw-voice-call-cli-rotation-");
    const file = path.join(tempRoot, "diagnostics.jsonl");
    const replacement = path.join(tempRoot, "replacement.jsonl");
    const initial = `${JSON.stringify({ seq: 0 })}\n{"old":"unfinished`;
    const replacementRecord = JSON.stringify({ seq: 1, padding: "x".repeat(256) });
    fs.writeFileSync(file, initial, "utf8");
    expect(Buffer.byteLength(replacementRecord)).toBeGreaterThan(Buffer.byteLength(initial));

    sleepMock
      .mockImplementationOnce(async () => {
        fs.writeFileSync(replacement, `${replacementRecord}\n`, "utf8");
        fs.renameSync(replacement, file);
      })
      .mockRejectedValueOnce(new Error("stop tail after replacement output"));

    const program = buildProgram({});
    const output = captureStdout();
    try {
      await expect(
        program.parseAsync(["voicecall", "tail", "--file", file, "--since", "1"], {
          from: "user",
        }),
      ).rejects.toThrow("stop tail after replacement output");
    } finally {
      output.restore();
    }

    const lines = output.output().trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([0, 1]);
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
