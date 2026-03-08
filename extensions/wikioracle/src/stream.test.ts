/**
 * stream.test.ts — Unit tests for the bin/wo CLI spawning layer.
 *
 * Tests cover:
 *   - buildArgs():    Argument construction for every WoOptions field.
 *   - createWoStream(): Spawn lifecycle — success, failure, spawn error,
 *                       stdout trimming, stderr propagation.
 *
 * child_process.spawn is mocked so no real process is launched.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArgs, createWoStream, type WoOptions } from "./stream.js";

// ─────────────────────────────────────────────────────────────────
//  Mock child_process.spawn
// ─────────────────────────────────────────────────────────────────

/**
 * Minimal fake ChildProcess with plain EventEmitter stdout/stderr.
 *
 * Using plain EventEmitters (not Readable streams) avoids buffering
 * issues — the "data" event fires synchronously when we emit it in
 * the test, so the handler in createWoStream picks it up immediately
 * before the "close" event.
 */
function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  return child;
}

let mockChild: ReturnType<typeof createMockChild>;
const spawnSpy = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnSpy(...args);
    return mockChild;
  },
}));

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

/** Minimal valid options — only required fields. */
function baseOpts(overrides: Partial<WoOptions> = {}): WoOptions {
  return {
    woPath: "/usr/local/bin/wo",
    serverUrl: "https://127.0.0.1:8888",
    insecure: false,
    stateful: false,
    stateFile: "",
    message: "Hello WikiOracle",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────
//  buildArgs
// ─────────────────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("includes -s <serverUrl> and the message as the last arg", () => {
    const args = buildArgs(baseOpts());
    expect(args[0]).toBe("-s");
    expect(args[1]).toBe("https://127.0.0.1:8888");
    expect(args.at(-1)).toBe("Hello WikiOracle");
  });

  it("adds -k when insecure is true", () => {
    const args = buildArgs(baseOpts({ insecure: true }));
    expect(args).toContain("-k");
  });

  it("omits -k when insecure is false", () => {
    const args = buildArgs(baseOpts({ insecure: false }));
    expect(args).not.toContain("-k");
  });

  it("adds --stateful when stateful is true", () => {
    const args = buildArgs(baseOpts({ stateful: true }));
    expect(args).toContain("--stateful");
  });

  it("omits --stateful when stateful is false", () => {
    const args = buildArgs(baseOpts({ stateful: false }));
    expect(args).not.toContain("--stateful");
  });

  it("adds -f <stateFile> when stateFile is non-empty", () => {
    const args = buildArgs(baseOpts({ stateFile: "/tmp/state.xml" }));
    const idx = args.indexOf("-f");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/state.xml");
  });

  it("omits -f when stateFile is empty", () => {
    const args = buildArgs(baseOpts({ stateFile: "" }));
    expect(args).not.toContain("-f");
  });

  it("adds -t <token> when token is provided", () => {
    const args = buildArgs(baseOpts({ token: "secret-token-123" }));
    const idx = args.indexOf("-t");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("secret-token-123");
  });

  it("omits -t when token is undefined", () => {
    const args = buildArgs(baseOpts({ token: undefined }));
    expect(args).not.toContain("-t");
  });

  it("adds --provider when provider is set", () => {
    const args = buildArgs(baseOpts({ provider: "anthropic" }));
    const idx = args.indexOf("--provider");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("anthropic");
  });

  it("omits --provider when provider is undefined", () => {
    const args = buildArgs(baseOpts());
    expect(args).not.toContain("--provider");
  });

  it("adds --model when model is set", () => {
    const args = buildArgs(baseOpts({ model: "gpt-4o" }));
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-4o");
  });

  it("adds --conversation-id when conversationId is set", () => {
    const args = buildArgs(baseOpts({ conversationId: "conv-abc" }));
    const idx = args.indexOf("--conversation-id");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("conv-abc");
  });

  it("adds --branch-from when branchFrom is set", () => {
    const args = buildArgs(baseOpts({ branchFrom: "parent-conv-xyz" }));
    const idx = args.indexOf("--branch-from");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("parent-conv-xyz");
  });

  it("adds --url-prefix when urlPrefix is set", () => {
    const args = buildArgs(baseOpts({ urlPrefix: "/api/v2" }));
    const idx = args.indexOf("--url-prefix");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/api/v2");
  });

  it("places the message as the final positional argument", () => {
    const args = buildArgs(
      baseOpts({
        insecure: true,
        stateful: true,
        provider: "openai",
        model: "gpt-4o",
        token: "tok",
        conversationId: "c1",
        branchFrom: "c0",
        urlPrefix: "/x",
        stateFile: "s.xml",
        message: "What is truth?",
      }),
    );
    expect(args.at(-1)).toBe("What is truth?");
  });

  it("builds a complete arg list with all optional fields", () => {
    const args = buildArgs(
      baseOpts({
        insecure: true,
        stateful: true,
        stateFile: "state.xml",
        token: "bearer-tok",
        provider: "wikioracle",
        model: "nanochat-v2",
        conversationId: "conv-1",
        branchFrom: "conv-0",
        urlPrefix: "/wo",
        message: "full test",
      }),
    );

    expect(args).toEqual([
      "-s",
      "https://127.0.0.1:8888",
      "-k",
      "--stateful",
      "-f",
      "state.xml",
      "-t",
      "bearer-tok",
      "--provider",
      "wikioracle",
      "--model",
      "nanochat-v2",
      "--conversation-id",
      "conv-1",
      "--branch-from",
      "conv-0",
      "--url-prefix",
      "/wo",
      "full test",
    ]);
  });

  it("builds a minimal arg list with only required fields", () => {
    const args = buildArgs(baseOpts());
    expect(args).toEqual(["-s", "https://127.0.0.1:8888", "Hello WikiOracle"]);
  });
});

// ─────────────────────────────────────────────────────────────────
//  createWoStream
// ─────────────────────────────────────────────────────────────────

describe("createWoStream", () => {
  beforeEach(() => {
    mockChild = createMockChild();
    spawnSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with trimmed stdout on exit code 0", async () => {
    const p = createWoStream(baseOpts());

    // Simulate bin/wo writing to stdout and exiting cleanly
    mockChild.stdout.emit("data", Buffer.from("  The answer is 42.  \n"));
    mockChild.emit("close", 0);

    await expect(p).resolves.toBe("The answer is 42.");
  });

  it("resolves with empty string when stdout is only whitespace", async () => {
    const p = createWoStream(baseOpts());

    mockChild.stdout.emit("data", Buffer.from("   \n\n  "));
    mockChild.emit("close", 0);

    await expect(p).resolves.toBe("");
  });

  it("concatenates multiple stdout chunks", async () => {
    const p = createWoStream(baseOpts());

    mockChild.stdout.emit("data", Buffer.from("Hello "));
    mockChild.stdout.emit("data", Buffer.from("World"));
    mockChild.emit("close", 0);

    await expect(p).resolves.toBe("Hello World");
  });

  it("rejects with stderr content on non-zero exit code", async () => {
    const p = createWoStream(baseOpts());

    mockChild.stderr.emit("data", Buffer.from("Connection refused"));
    mockChild.emit("close", 1);

    await expect(p).rejects.toThrow("bin/wo exited with code 1: Connection refused");
  });

  it("rejects with stdout content when stderr is empty on failure", async () => {
    const p = createWoStream(baseOpts());

    mockChild.stdout.emit("data", Buffer.from("Error: bad request"));
    mockChild.emit("close", 2);

    await expect(p).rejects.toThrow("bin/wo exited with code 2: Error: bad request");
  });

  it("rejects with just exit code when both stdout and stderr are empty", async () => {
    const p = createWoStream(baseOpts());

    mockChild.emit("close", 127);

    await expect(p).rejects.toThrow("bin/wo exited with code 127");
  });

  it("rejects on spawn error (e.g. binary not found)", async () => {
    const opts = baseOpts({ woPath: "/nonexistent/bin/wo" });
    const p = createWoStream(opts);

    const absPath = path.resolve("/nonexistent/bin/wo");
    mockChild.emit("error", new Error("ENOENT: no such file or directory"));

    await expect(p).rejects.toThrow(
      `Failed to spawn bin/wo at ${absPath}: ENOENT: no such file or directory`,
    );
  });

  it("passes the resolved absolute path to spawn", async () => {
    const p = createWoStream(baseOpts({ woPath: "../bin/wo" }));

    mockChild.stdout.emit("data", Buffer.from("ok"));
    mockChild.emit("close", 0);
    await p;

    const resolvedPath = path.resolve("../bin/wo");
    expect(spawnSpy).toHaveBeenCalledWith(
      resolvedPath,
      expect.any(Array),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("passes the correct args to spawn", async () => {
    const opts = baseOpts({
      insecure: true,
      stateful: true,
      provider: "openai",
    });
    const p = createWoStream(opts);

    mockChild.stdout.emit("data", Buffer.from("ok"));
    mockChild.emit("close", 0);
    await p;

    const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("-k");
    expect(spawnArgs).toContain("--stateful");
    expect(spawnArgs).toContain("--provider");
    expect(spawnArgs).toContain("openai");
    expect(spawnArgs.at(-1)).toBe("Hello WikiOracle");
  });

  it("uses the default timeout of 120s when timeoutMs is not set", async () => {
    const p = createWoStream(baseOpts());

    mockChild.emit("close", 0);
    await p;

    const spawnOpts = spawnSpy.mock.calls[0][2] as { timeout: number };
    expect(spawnOpts.timeout).toBe(120_000);
  });

  it("uses a custom timeout when timeoutMs is set", async () => {
    const p = createWoStream(baseOpts({ timeoutMs: 30_000 }));

    mockChild.emit("close", 0);
    await p;

    const spawnOpts = spawnSpy.mock.calls[0][2] as { timeout: number };
    expect(spawnOpts.timeout).toBe(30_000);
  });

  it("prefers stderr over stdout in error messages", async () => {
    const p = createWoStream(baseOpts());

    mockChild.stdout.emit("data", Buffer.from("some stdout noise"));
    mockChild.stderr.emit("data", Buffer.from("the real error"));
    mockChild.emit("close", 1);

    await expect(p).rejects.toThrow("bin/wo exited with code 1: the real error");
  });
});
