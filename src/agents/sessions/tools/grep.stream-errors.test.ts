// Grep tool stream error tests verify that stdout/stderr errors reject the tool
// promise instead of crashing the agent runtime.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool } from "../../utils/tools-manager.js";
import { createGrepToolDefinition } from "./grep.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

type MockChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };

function createChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => true),
  }) as unknown as MockChild;
}

describe("grep tool stream errors", () => {
  it("rejects when stdout emits an error", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const resultPromise = tool.execute(
      "call-1",
      { pattern: "foo" },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.emit("error", new Error("stdout EPIPE"));

    await expect(resultPromise).rejects.toThrow("stdout EPIPE");
    expect(child.killed).toBe(true);
  });

  it("rejects when stderr emits an error", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const resultPromise = tool.execute(
      "call-1",
      { pattern: "foo" },
      undefined,
      undefined,
      {} as never,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit("error", new Error("stderr EPIPE"));

    await expect(resultPromise).rejects.toThrow("stderr EPIPE");
    expect(child.killed).toBe(true);
  });
});
