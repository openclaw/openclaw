// find tool tests cover custom search operation wiring and result-limit
// normalization for session file discovery.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition, type FindOperations } from "./find.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);
const mockedEnsureTool = vi.mocked(ensureTool);

function operations(results: string[]): FindOperations {
  return {
    exists: () => true,
    glob: (_pattern, _cwd, options) => results.slice(0, options.limit),
  };
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createFindToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("find tool", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("clamps non-positive limits before delegating to custom search operations", async () => {
    // Clamp before delegation so custom backends never receive a zero/negative
    // limit that could make real matches disappear.
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await tool.execute(
      "call-1",
      { pattern: "*.ts", limit: -4 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("a.ts\n\n[1 results limit reached]");
    expect(result.details?.resultLimitReached).toBe(1);
  });

  it("uses the default limit for non-finite values", async () => {
    const tool = createFindToolDefinition("/workspace", {
      operations: operations(["/workspace/a.ts", "/workspace/b.ts"]),
    });

    const result = await tool.execute(
      "call-1",
      { pattern: "*.ts", limit: Number.POSITIVE_INFINITY },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("a.ts\nb.ts");
    expect(result.details).toBeUndefined();
  });

  it("rejects partial fd output when fd exits with an error", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcessWithoutNullStreams;
    mockedSpawn.mockReturnValue(child);
    mockedEnsureTool.mockResolvedValue("fd");

    const tool = createFindToolDefinition("/workspace");
    const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
    child.stdout.write("/workspace/partial.ts\n");
    child.stderr.write("fd failed while reading subtree\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 2, null);

    await expect(result).rejects.toThrow("fd failed while reading subtree");
  });
});
