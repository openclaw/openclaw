import fs from "node:fs/promises";
import path from "node:path";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { classifyWorkspaceMemoryPaths } from "../workspace-path-classifier.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

createMemoryCoreTestHarness();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.restoreAllMocks());
const untrustedProvenance = {
  fileHash: "0".repeat(64),
  originClass: "untrusted",
  observedAt: 1,
} as const;

describe("memory path provenance", () => {
  it("classifies loaded remote sources without probing Gateway-local decoys", async () => {
    const workspaceDir = tempDirs.make("remote-memory-provenance-");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Gateway decoy");
    const realpath = vi.spyOn(fs, "realpath");
    vi.mocked(readMemoryArtifactProvenance).mockImplementation(async ({ relativePath }) =>
      relativePath === "memory/tainted.md" ? untrustedProvenance : undefined,
    );
    await expect(
      classifyWorkspaceMemoryPaths({
        cfg: {},
        agentId: "main",
        workspaceDir,
        relativePaths: ["USER.md", "MEMORY.md", "alias/MEMORY.md", "missing/MEMORY.md"],
        readSources: [
          { relativePath: "USER.md", canonicalRelativePath: "USER.md" },
          { relativePath: "MEMORY.md" },
          { relativePath: "alias/MEMORY.md", canonicalRelativePath: "memory/tainted.md" },
        ],
      }),
    ).resolves.toEqual([
      { relativePath: "USER.md", originClass: "agent" },
      { relativePath: "MEMORY.md", originClass: "untrusted" },
      { relativePath: "alias/MEMORY.md", originClass: "untrusted" },
      { relativePath: "missing/MEMORY.md", originClass: "untrusted" },
    ]);
    expect(realpath).not.toHaveBeenCalled();
    expect(readMemoryArtifactProvenance).toHaveBeenCalledWith({
      workspaceDir,
      relativePath: "memory/tainted.md",
    });
  });

  it.each(["../USER.md", "/USER.md", "memory/../USER.md", "C:\\USER.md", "notes/USER.md"])(
    "does not promote a remote source outside native memory paths: %s",
    async (canonicalRelativePath) => {
      await expect(
        resolveMemoryPathClassification({
          absolutePath: "/workspace/USER.md",
          source: "memory",
          workspaceDir: "/workspace",
          readSource: { canonicalRelativePath },
        }),
      ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });
    },
  );
  it("trusts canonical workspace memory while excluding system and lookalike paths", async () => {
    const root = tempDirs.make("memory-path-provenance-");
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "Memory"), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const check = async (
      file: string,
      originClass: "agent" | "system" | "untrusted",
      curatedRoot = false,
      source: "memory" | "sessions" = "memory",
    ) => {
      const absolutePath = path.join(workspaceDir, file);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "fixture");
      await expect(
        resolveMemoryPathClassification({ absolutePath, source, workspaceDir }),
      ).resolves.toEqual({ curatedRoot, originClass });
    };
    await check("MEMORY.md", "agent", true);
    await check("USER.md", "agent", true);
    await check("users/person/USER.md", "agent");
    await check("users/person/notes.md", "untrusted");
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValueOnce(untrustedProvenance);
    await check("users/person/USER.md", "untrusted");
    await check("memory/2026-07-27.md", "agent");
    await check("memory/projects/notes.md", "agent");
    await check("DREAMS.md", "system");
    await check("memory/dreaming/deep/report.md", "system");
    await check("notes/extra.md", "untrusted");
    const caseVariantDir = await fs.realpath(path.join(workspaceDir, "Memory"));
    if (path.basename(caseVariantDir) === "Memory") {
      await check("Memory/payload.md", "untrusted");
    }
    await check("memory/2026-07-27.md", "untrusted", false, "sessions");

    const outsideFile = path.join(outsideDir, "payload.md");
    await fs.writeFile(outsideFile, "outside");
    if (process.platform !== "win32") {
      await fs.symlink(outsideFile, path.join(workspaceDir, "memory", "linked.md"));
      await expect(
        resolveMemoryPathClassification({
          absolutePath: path.join(workspaceDir, "memory", "linked.md"),
          source: "memory",
          workspaceDir,
        }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    }
  });

  it("honors sticky untrusted provenance for runtime-written memory files", async () => {
    const workspaceDir = tempDirs.make("memory-path-runtime-taint-");
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(absolutePath, "network-authored memory", "utf8");
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValueOnce(untrustedProvenance);

    await expect(
      resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
    ).resolves.toEqual({ curatedRoot: true, originClass: "untrusted" });
  });
});
