import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import { readWorkspaceContextForSummary } from "./compaction-workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { compactionLogger } = vi.hoisted(() => ({ compactionLogger: { warn: vi.fn() } }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => compactionLogger,
}));
beforeEach(() => compactionLogger.warn.mockClear());

function workspace(content: string) {
  const root = tempDirs.make("openclaw-compaction-summary-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), content);
  return root;
}

function expectWarning(text: string) {
  expect(compactionLogger.warn).toHaveBeenCalledWith(expect.stringContaining(text));
}

const limitPrefix = "## Session Startup\n\n" + "x".repeat(1_999 - "## Session Startup\n\n".length);
const boundedContent = `${limitPrefix}🚀tail\n`;
const startup = ["Session Startup"];
const read = (root: string | undefined) => readWorkspaceContextForSummary(startup, root);
it.each<[string, string, string[], string?, string[]?]>([
  ["disabled sections", "## Session Startup\n\nRead AGENTS.md\n", [], undefined, []],
  [
    "oversized file",
    `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
    [],
    "File exceeds 2097152 bytes",
  ],
  [
    "file at the byte limit",
    boundedContent +
      "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - Buffer.byteLength(boundedContent)),
    ["<workspace-critical-rules>", `${limitPrefix}\n...[truncated]...`],
  ],
  [
    "legacy defaults",
    "## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n",
    ["Do startup things", "Be safe"],
    undefined,
    ["Red Lines", "Session Startup"],
  ],
  ["missing sections", "## Other\nNo rules\n", [], "found 0 of 1 configured sections"],
  [
    "partially missing configured sections",
    "## Session Startup\nRead AGENTS.md\n",
    ["Read AGENTS.md"],
    "found 1 of 2 configured sections",
    ["Session Startup", "Red Lines"],
  ],
])("reads workspace context with %s", async (_, content, expected, warning, sections = startup) => {
  const result = await readWorkspaceContextForSummary(sections, workspace(content));
  if (warning) {
    expectWarning(warning);
  } else {
    expect(compactionLogger.warn).not.toHaveBeenCalled();
  }
  if (expected.length === 0) {
    expect(result).toBe("");
  } else {
    for (const text of expected) {
      expect(result).toContain(text);
    }
  }
});

it("reads workspace context from the configured workspace instead of process cwd", async () => {
  const processRoot = workspace("## Session Startup\nWrong cwd\n");
  const workspaceRoot = workspace("## Session Startup\nWorkspace rules\n\n## Other\nIgnore me\n");
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(processRoot);
  try {
    const result = await read(workspaceRoot);

    expect(result).toContain("Workspace rules");
    expect(result).not.toMatch(/Wrong cwd|Ignore me/);
    await expect(read(undefined)).resolves.toBe("");
    expectWarning("no agent workspace");
    fs.unlinkSync(path.join(workspaceRoot, "AGENTS.md"));
    await expect(read(workspaceRoot)).resolves.toBe("");
    expectWarning(`cannot open ${path.join(workspaceRoot, "AGENTS.md")}`);
    expect(result).toContain("<workspace-critical-rules>");
  } finally {
    cwdSpy.mockRestore();
  }
});

it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
  "returns empty when AGENTS.md is a %s alias",
  async (kind) => {
    const root = tempDirs.make("openclaw-compaction-summary-");
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "secret");
    const link = kind === "symlink" ? fs.symlinkSync : fs.linkSync;
    link(outside, path.join(root, "AGENTS.md"));
    await expect(
      readWorkspaceContextForSummary(["Session Startup", "Red Lines"], root),
    ).resolves.toBe("");
  },
);
