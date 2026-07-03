import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition } from "./find.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

it("rejects partial fd output when fd exits with an error", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  stdout.end("/workspace/partial.ts\n");
  stderr.end("fd failed while reading subtree\n");
  child.emit("close", 2, null);

  await expect(result).rejects.toThrow("fd failed while reading subtree");
});
