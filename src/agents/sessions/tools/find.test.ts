// find tool tests cover custom search operation wiring and result-limit
// normalization for session file discovery.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition, type FindOperations } from "./find.js";

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const mockedEnsureTool = vi.mocked(ensureTool);
const tempDirs = useAutoCleanupTempDirTracker();

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
    const tempDir = tempDirs.make("openclaw-find-fd-");
    const fdPath = join(tempDir, "fd");
    writeFileSync(
      fdPath,
      `#!/usr/bin/env node
const searchRoot = process.argv[process.argv.length - 1];
process.stdout.write(searchRoot + "/partial.ts\\n");
process.stderr.write("fd failed while reading subtree\\n");
process.exit(2);
`,
    );
    chmodSync(fdPath, 0o755);
    mockedEnsureTool.mockResolvedValue(fdPath);

    const tool = createFindToolDefinition(tempDir);

    await expect(
      tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never),
    ).rejects.toThrow("fd failed while reading subtree");
  });
});
