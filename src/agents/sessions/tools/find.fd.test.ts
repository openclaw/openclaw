import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition } from "./find.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type MockChild = ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };

afterEach(() => {
  vi.clearAllMocks();
});

function createChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => true),
  }) as unknown as MockChild;
}

it("rejects partial fd output when fd exits with an error", async () => {
  const child = createChild();
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(ensureTool).mockResolvedValue("fd");

  const tool = createFindToolDefinition("/workspace");
  const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stdout.end("/workspace/partial.ts\n");
  child.stderr.end("fd failed while reading subtree\n");
  child.emit("close", 2, null);

  await expect(result).rejects.toThrow("fd failed while reading subtree");
});

it.each([
  { name: "inside a repository", gitBoundary: true, expected: false },
  { name: "outside a repository", gitBoundary: false, expected: true },
])("sets --no-require-git only $name", async ({ gitBoundary, expected }) => {
  const tempDir = tempDirs.make("openclaw-find-fd-");
  const searchPath = path.join(tempDir, "nested");
  await fs.mkdir(searchPath, { recursive: true });
  if (gitBoundary) {
    await fs.writeFile(path.join(tempDir, ".git"), "gitdir: /tmp/example\n");
  }

  const child = createChild();
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(ensureTool).mockResolvedValue("fd");
  const tool = createFindToolDefinition(tempDir);
  const result = tool.execute(
    "call-git-boundary",
    { pattern: "AGENTS.md", path: searchPath },
    undefined,
    undefined,
    {} as never,
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await result;

  const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
  expect(args.includes("--no-require-git")).toBe(expected);
});
