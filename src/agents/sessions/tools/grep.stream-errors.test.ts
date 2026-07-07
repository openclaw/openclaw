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
  let killed = false;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as MockChild;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

describe("grep tool stream errors", () => {
  it.each(["stdout", "stderr"] as const)(
    "rejects and terminates ripgrep when %s fails",
    async (stream) => {
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
      child[stream].emit("error", new Error(`${stream} EPIPE`));

      await expect(resultPromise).rejects.toThrow(`${stream} EPIPE`);
      expect(child.killed).toBe(true);
    },
  );

  it("keeps stdout guarded after a stderr failure closes readline", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(ensureTool).mockResolvedValue("rg");

    const tool = createGrepToolDefinition(process.cwd());
    const result = tool.execute("call-1", { pattern: "foo" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(() => {
      child.stderr.emit("error", new Error("stderr first"));
      child.stdout.emit("error", new Error("stdout later"));
    }).not.toThrow();
    await expect(result).rejects.toThrow("stderr first");
  });
});
