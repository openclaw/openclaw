import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerOrchestratorCli } from "../src/cli.js";
import { tryReadCredentials } from "../src/credentials.js";

let tmpRoot: string;
let credPath: string;

function captureOut(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

function buildProgram(out: NodeJS.WritableStream): Command {
  const program = new Command();
  program.exitOverride();
  registerOrchestratorCli(program, { out, credentialsPath: credPath });
  return program;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-cli-"));
  mkdirSync(join(tmpRoot, "credentials"), { recursive: true });
  credPath = join(tmpRoot, "credentials", "orchestrator-bearer.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("init", () => {
  test("creates a fresh credentials file when none exists", async () => {
    const { stream, read } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "init"], { from: "user" });
    expect(read()).toContain("created");
    const creds = tryReadCredentials({ path: credPath });
    expect(creds?.token).toHaveLength(64);
  });

  test("refuses to overwrite without --force", async () => {
    const { stream } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "init"], { from: "user" });
    const original = tryReadCredentials({ path: credPath })?.token;

    const { stream: stream2, read } = captureOut();
    await buildProgram(stream2).parseAsync(["orchestrator", "init"], { from: "user" });
    expect(read()).toContain("already exists");
    expect(tryReadCredentials({ path: credPath })?.token).toBe(original);
  });

  test("re-running init when a token already exists is idempotent (exit 0)", async () => {
    const { stream } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "init"], { from: "user" });
    process.exitCode = 0;
    const { stream: stream2 } = captureOut();
    await buildProgram(stream2).parseAsync(["orchestrator", "init"], { from: "user" });
    expect(process.exitCode).toBe(0);
  });

  test("--force replaces the existing token", async () => {
    const { stream } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "init"], { from: "user" });
    const original = tryReadCredentials({ path: credPath })?.token;

    const { stream: stream2 } = captureOut();
    await buildProgram(stream2).parseAsync(["orchestrator", "init", "--force"], { from: "user" });
    const next = tryReadCredentials({ path: credPath })?.token;
    expect(next).not.toBe(original);
    expect(next).toHaveLength(64);
  });
});

describe("rotate-token", () => {
  test("creates the file on first run if missing", async () => {
    const { stream, read } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "rotate-token"], { from: "user" });
    expect(read()).toContain("rotated");
    expect(tryReadCredentials({ path: credPath })?.token).toHaveLength(64);
  });

  test("replaces an existing token in place", async () => {
    const { stream } = captureOut();
    await buildProgram(stream).parseAsync(["orchestrator", "init"], { from: "user" });
    const original = tryReadCredentials({ path: credPath })?.token;
    const { stream: stream2 } = captureOut();
    await buildProgram(stream2).parseAsync(["orchestrator", "rotate-token"], { from: "user" });
    const rotated = tryReadCredentials({ path: credPath })?.token;
    expect(rotated).not.toBe(original);
  });
});

describe("registerOrchestratorCli", () => {
  test("registers exactly the documented verbs", () => {
    const { stream } = captureOut();
    const program = buildProgram(stream);
    const orchestrator = program.commands.find((c) => c.name() === "orchestrator");
    const verbs = (orchestrator?.commands ?? []).map((c) => c.name()).toSorted();
    expect(verbs).toEqual(["init", "rotate-token", "shadow-summary", "synthetic", "synthetic-all"]);
  });
});
