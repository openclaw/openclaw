// Voice Call tests cover cli plugin behavior.
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerVoiceCallCli, testing } from "./cli.js";

describe("voice-call CLI gateway fallback", () => {
  it("treats abnormal local gateway closes as standalone-runtime fallback candidates", () => {
    expect(
      testing.isGatewayUnavailableForLocalFallback(
        new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
      ),
    ).toBe(true);
  });
});

describe("parseVoiceCallIntOption", () => {
  it("parses decimal integer option values", () => {
    expect(testing.parseVoiceCallIntOption("250", "--poll", { min: 50 })).toBe(250);
    expect(testing.parseVoiceCallIntOption(" 25 ", "--since")).toBe(25);
  });

  it("rejects non-decimal JavaScript numeric syntax", () => {
    expect(() => testing.parseVoiceCallIntOption("0x10", "--last")).toThrow(
      "Invalid numeric value for --last: 0x10",
    );
    expect(() => testing.parseVoiceCallIntOption("1e3", "--last")).toThrow(
      "Invalid numeric value for --last: 1e3",
    );
  });

  it("rejects unsafe integers and max-bound violations", () => {
    expect(() => testing.parseVoiceCallIntOption("9007199254740993", "--last", { min: 1 })).toThrow(
      "Invalid numeric value for --last: 9007199254740993",
    );
    expect(() =>
      testing.parseVoiceCallIntOption("65536", "--port", { min: 1, max: 65535 }),
    ).toThrow("Invalid numeric value for --port: 65536");
  });
});

describe("voice-call CLI timeout helpers", () => {
  it("caps gateway operation timeout grace", () => {
    expect(testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: 10_000 } as never)).toBe(
      30_000,
    );
    expect(testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: 60_000 } as never)).toBe(
      65_000,
    );
    expect(
      testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: Number.MAX_SAFE_INTEGER } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: Number.MAX_VALUE } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps gateway continue timeout totals", () => {
    expect(testing.resolveGatewayContinueTimeoutMs({ transcriptTimeoutMs: 180_000 } as never)).toBe(
      220_000,
    );
    expect(
      testing.resolveGatewayContinueTimeoutMs({
        transcriptTimeoutMs: Number.MAX_SAFE_INTEGER,
      } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps gateway polling deadlines", () => {
    expect(testing.resolveVoiceCallDeadlineMs(5_000, 10_000)).toBe(15_000);
    expect(testing.resolveVoiceCallDeadlineMs(Number.MAX_SAFE_INTEGER, 10_000)).toBe(
      10_000 + MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("caps gateway continue poll timeouts from async operation payloads", () => {
    expect(
      testing.readGatewayPollTimeoutMs({ pollTimeoutMs: Number.MAX_SAFE_INTEGER }, 45_000),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(testing.readGatewayPollTimeoutMs({ pollTimeoutMs: Number.NaN }, 45_000)).toBe(45_000);
  });
});

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
    testing.setCallGatewayFromCliForTests(undefined);
  });

  function buildProgram(manager: Record<string, unknown>): Command {
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: {} as never,
      ensureRuntime: async () => ({ manager }) as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    return program;
  }

  async function runStatusWithUnavailableGateway(
    manager: Record<string, unknown>,
  ): Promise<unknown> {
    testing.setCallGatewayFromCliForTests(
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
      }) as never,
    );
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
});
