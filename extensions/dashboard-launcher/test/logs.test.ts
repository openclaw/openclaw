import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { tailLogs } from "../src/logs.js";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "dashboard-launcher-logs-"));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function captureSink(): { sink: PassThrough; read: () => string } {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(c));
  return { sink, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("tailLogs", () => {
  test("returns last N lines", async () => {
    const file = join(tmpHome, "out.log");
    writeFileSync(file, ["one", "two", "three", "four"].join("\n") + "\n");
    const { sink, read } = captureSink();
    const result = await tailLogs({ filePath: file, lines: 2, out: sink });
    expect(result.exitCode).toBe(0);
    expect(read()).toBe("three\nfour\n");
  });

  test("emits a friendly message when the log file is missing", async () => {
    const missing = join(tmpHome, "no-such-log.log");
    const { sink, read } = captureSink();
    const result = await tailLogs({ filePath: missing, out: sink });
    expect(result.exitCode).toBe(0);
    expect(read()).toContain("no logs yet");
  });

  test("renders all lines when count exceeds line total", async () => {
    const file = join(tmpHome, "small.log");
    writeFileSync(file, "only one\n");
    const { sink, read } = captureSink();
    await tailLogs({ filePath: file, lines: 50, out: sink });
    expect(read()).toBe("only one\n");
  });
});
