import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function expectWorkspaceSummaryEmptyForAgentsAlias(
  createAlias: (outsidePath: string, agentsPath: string) => void,
) {
  const root = tempDirs.make("openclaw-compaction-summary-");
  const outside = path.join(root, "outside-secret.txt");
  fs.writeFileSync(outside, "secret");
  createAlias(outside, path.join(root, "AGENTS.md"));
  await expect(
    readWorkspaceContextForSummary(["Session Startup", "Red Lines"], root),
  ).resolves.toBe("");
}

describe("readWorkspaceContextForSummary", () => {
  async function withWorkspaceSummary(
    content: string,
    sectionNames: string[] | undefined,
  ): Promise<string> {
    const root = tempDirs.make("openclaw-compaction-summary-");
    fs.writeFileSync(path.join(root, "AGENTS.md"), content);
    return readWorkspaceContextForSummary(sectionNames, root);
  }

  const limitPrefix =
    "## Session Startup\n\n" + "x".repeat(1_999 - "## Session Startup\n\n".length);
  const boundedContent = `${limitPrefix}🚀tail\n`;
  it.each([
    {
      name: "disabled sections",
      warning: undefined,
      content: "## Session Startup\n\nRead AGENTS.md\n",
      sections: [],
      expected: [],
    },
    {
      name: "oversized file",
      warning: "File exceeds 2097152 bytes",
      content: `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
      sections: ["Session Startup"],
      expected: [],
    },
    {
      name: "file at the byte limit",
      warning: undefined,
      content:
        boundedContent +
        "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - Buffer.byteLength(boundedContent)),
      sections: ["Session Startup"],
      expected: ["<workspace-critical-rules>", `${limitPrefix}\n...[truncated]...`],
    },
    {
      name: "legacy defaults",
      warning: undefined,
      content: "## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n",
      sections: ["Red Lines", "Session Startup"],
      expected: ["Do startup things", "Be safe"],
    },
    {
      name: "missing configured sections",
      content: "## Other\nUnrelated rules.\n",
      sections: ["Session Startup"],
      expected: [],
      warning: "found 0 of 1 configured sections",
    },
    {
      name: "partially missing configured sections",
      content: "## Session Startup\nRead AGENTS.md\n",
      sections: ["Session Startup", "Red Lines"],
      expected: ["Read AGENTS.md"],
      warning: "found 1 of 2 configured sections",
    },
  ])("reads workspace context with $name", async ({ content, sections, expected, warning }) => {
    const result = await withWorkspaceSummary(content, sections);
    if (warning) {
      expect(compactionLogger.warn).toHaveBeenCalledWith(expect.stringContaining(warning));
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
    const processRoot = tempDirs.make("openclaw-compaction-cwd-");
    const workspaceRoot = tempDirs.make("openclaw-compaction-workspace-");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(processRoot);
    try {
      fs.writeFileSync(
        path.join(processRoot, "AGENTS.md"),
        "## Session Startup\n\nWrong cwd rules.\n",
      );
      fs.writeFileSync(
        path.join(workspaceRoot, "AGENTS.md"),
        "## Session Startup\n\nUse the run workspace rules.\n\n## Other\nIgnore me.\n",
      );

      const result = await readWorkspaceContextForSummary(["Session Startup"], workspaceRoot);

      expect(result).toContain("Use the run workspace rules.");
      expect(result).not.toContain("Wrong cwd rules.");
      expect(result).not.toContain("Ignore me.");
      await expect(readWorkspaceContextForSummary(["Session Startup"], undefined)).resolves.toBe(
        "",
      );
      expect(compactionLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("no agent workspace"),
      );
      fs.unlinkSync(path.join(workspaceRoot, "AGENTS.md"));
      await expect(
        readWorkspaceContextForSummary(["Session Startup"], workspaceRoot),
      ).resolves.toBe("");
      expect(compactionLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`cannot open ${path.join(workspaceRoot, "AGENTS.md")}`),
      );
      expect(result).toContain("<workspace-critical-rules>");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "returns empty when AGENTS.md is a %s alias",
    async (kind) => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        if (kind === "symlink") {
          fs.symlinkSync(outside, agentsPath);
        } else {
          fs.linkSync(outside, agentsPath);
        }
      });
    },
  );
});
