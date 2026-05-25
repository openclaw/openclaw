import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildVerifiedInboundRecord,
  recordVerifiedInboundMessage,
  resolveVerifiedInboundRecorderConfig,
  selectVerifiedInboundRawText,
  type SpawnRecorder,
} from "./verified-inbound-recorder.js";

type FakeChild = EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** Spawn stub that captures argv/stdin and lets the test drive the exit. */
function createSpawnStub(behavior: {
  exitCode?: number | null;
  errorOnSpawn?: Error;
  stderr?: string;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let lastStdin: string | undefined;
  const spawnImpl = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = createFakeChild();
    child.stdin.end.mockImplementation((payload?: string) => {
      lastStdin = payload;
      queueMicrotask(() => {
        if (behavior.errorOnSpawn) {
          child.emit("error", behavior.errorOnSpawn);
          return;
        }
        if (behavior.stderr) {
          child.stderr.emit("data", behavior.stderr);
        }
        child.emit("close", behavior.exitCode ?? 0);
      });
    });
    return child;
  }) as unknown as SpawnRecorder;
  return {
    spawnImpl,
    calls,
    getStdin: () => lastStdin,
  };
}

describe("resolveVerifiedInboundRecorderConfig", () => {
  it("returns undefined when no command is configured", () => {
    expect(resolveVerifiedInboundRecorderConfig({})).toBeUndefined();
    expect(
      resolveVerifiedInboundRecorderConfig({ OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "   " }),
    ).toBeUndefined();
  });

  it("defaults tenant to johnny and require to false", () => {
    const config = resolveVerifiedInboundRecorderConfig({
      OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "record",
    });
    expect(config).toEqual({ command: "record", args: [], tenantId: "johnny", require: false });
  });

  it("parses JSON-array args and require flag and tenant override", () => {
    const config = resolveVerifiedInboundRecorderConfig({
      OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/usr/bin/record",
      OPENCLAW_VERIFIED_INBOUND_RECORDER_ARGS: '["--mode", "verified inbound"]',
      OPENCLAW_VERIFIED_INBOUND_TENANT: "acme",
      OPENCLAW_VERIFIED_INBOUND_REQUIRE: "1",
    });
    expect(config).toEqual({
      command: "/usr/bin/record",
      args: ["--mode", "verified inbound"],
      tenantId: "acme",
      require: true,
    });
  });
});

describe("buildVerifiedInboundRecord", () => {
  const fixedNow = () => new Date("2026-05-25T00:00:00.000Z");

  it("builds a full provenance row", () => {
    const record = buildVerifiedInboundRecord({
      tenantId: "johnny",
      sourceMessageId: "m1",
      sourceSenderId: "u1",
      rawText: "hello there",
      now: fixedNow,
    });
    expect(record).toEqual({
      tenant_id: "johnny",
      source_channel: "discord",
      source_message_id: "m1",
      source_sender_id: "u1",
      raw_text: "hello there",
      provider: "discord",
      channel: "discord",
      surface: "discord",
      recorded_at: "2026-05-25T00:00:00.000Z",
    });
  });

  it("returns undefined for empty/whitespace text or missing identity", () => {
    const base = { tenantId: "johnny", sourceMessageId: "m1", sourceSenderId: "u1" };
    expect(buildVerifiedInboundRecord({ ...base, rawText: "" })).toBeUndefined();
    expect(buildVerifiedInboundRecord({ ...base, rawText: "   " })).toBeUndefined();
    expect(
      buildVerifiedInboundRecord({ ...base, sourceMessageId: "", rawText: "hi" }),
    ).toBeUndefined();
    expect(
      buildVerifiedInboundRecord({ ...base, sourceSenderId: "", rawText: "hi" }),
    ).toBeUndefined();
  });
});

describe("selectVerifiedInboundRawText", () => {
  it("prefers the first non-empty candidate", () => {
    expect(selectVerifiedInboundRawText("", "forwarded text")).toBe("forwarded text");
    expect(selectVerifiedInboundRawText("   ", "base text")).toBe("base text");
    expect(selectVerifiedInboundRawText("agent text", "base text")).toBe("agent text");
  });

  it("preserves an all-empty candidate for incomplete-record handling", () => {
    expect(selectVerifiedInboundRawText("", undefined)).toBe("");
    expect(selectVerifiedInboundRawText(undefined)).toBeUndefined();
  });
});

describe("recordVerifiedInboundMessage", () => {
  const baseInbound = {
    sourceMessageId: "m1",
    sourceSenderId: "u1",
    rawText: "hello there",
  };

  it("does not call the recorder when env is unset", async () => {
    const { spawnImpl } = createSpawnStub({ exitCode: 0 });
    await recordVerifiedInboundMessage({ env: {}, ...baseInbound, spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("passes expected payload on stdin when configured", async () => {
    const { spawnImpl, calls, getStdin } = createSpawnStub({ exitCode: 0 });
    await recordVerifiedInboundMessage({
      env: {
        OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/usr/bin/record",
        OPENCLAW_VERIFIED_INBOUND_RECORDER_ARGS: '["--in"]',
      },
      ...baseInbound,
      provider: "discord",
      channel: "discord",
      surface: "discord",
      spawnImpl,
      now: () => new Date("2026-05-25T00:00:00.000Z"),
    });
    expect(calls).toEqual([{ command: "/usr/bin/record", args: ["--in"] }]);
    const payload = JSON.parse(String(getStdin())) as Record<string, unknown>;
    expect(payload).toMatchObject({
      tenant_id: "johnny",
      source_channel: "discord",
      source_message_id: "m1",
      source_sender_id: "u1",
      raw_text: "hello there",
    });
  });

  it("logs and continues when recorder fails and require is false", async () => {
    const { spawnImpl } = createSpawnStub({ exitCode: 1, stderr: "boom" });
    const log = vi.fn();
    await expect(
      recordVerifiedInboundMessage({
        env: { OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/usr/bin/record" },
        ...baseInbound,
        spawnImpl,
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("verified inbound recorder failed");
  });

  it("throws when recorder fails and require is true", async () => {
    const { spawnImpl } = createSpawnStub({ exitCode: 2, stderr: "denied" });
    await expect(
      recordVerifiedInboundMessage({
        env: {
          OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/usr/bin/record",
          OPENCLAW_VERIFIED_INBOUND_REQUIRE: "1",
        },
        ...baseInbound,
        spawnImpl,
      }),
    ).rejects.toThrow(/exited 2/);
  });

  it("throws on incomplete record when require is true", async () => {
    const { spawnImpl } = createSpawnStub({ exitCode: 0 });
    await expect(
      recordVerifiedInboundMessage({
        env: {
          OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/usr/bin/record",
          OPENCLAW_VERIFIED_INBOUND_REQUIRE: "1",
        },
        sourceMessageId: "m1",
        sourceSenderId: "u1",
        rawText: "   ",
        spawnImpl,
      }),
    ).rejects.toThrow(/incomplete/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("rejects on spawn error when require is true", async () => {
    const { spawnImpl } = createSpawnStub({ errorOnSpawn: new Error("ENOENT") });
    await expect(
      recordVerifiedInboundMessage({
        env: {
          OPENCLAW_VERIFIED_INBOUND_RECORDER_CMD: "/missing",
          OPENCLAW_VERIFIED_INBOUND_REQUIRE: "1",
        },
        ...baseInbound,
        spawnImpl,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
