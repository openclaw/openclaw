import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScopedWorkingMemoryInjectionStats,
  defaultCronWorkingMemoryPath,
  fitScopedWorkingMemoryContextFileToBudget,
  loadScopedWorkingMemoryContextFile,
  normalizeScopedWorkingMemoryPath,
} from "./scoped-working-memory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("scoped working memory helpers", () => {
  it("builds a stable default cron working-memory path", () => {
    expect(defaultCronWorkingMemoryPath("nightly privacy watch")).toBe(
      ".openclaw/working-memory/cron/nightly-privacy-watch.md",
    );
  });

  it("rejects paths outside the scoped working-memory root", () => {
    expect(() => normalizeScopedWorkingMemoryPath("MEMORY.md")).toThrow(
      /must live under .openclaw\/working-memory\//,
    );
  });

  it("loads scoped working-memory files from the workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-working-memory-"));
    tempDirs.push(workspaceDir);
    const relativePath = ".openclaw/working-memory/cron/nightly.md";
    const absolutePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "Current state\n- keep it scoped\n", "utf8");

    const loaded = await loadScopedWorkingMemoryContextFile({
      workspaceDir,
      relativePath,
    });

    expect(loaded.contextFile).toEqual({
      path: relativePath,
      content: "Current state\n- keep it scoped\n",
    });
    expect(loaded.file).toEqual({
      path: relativePath,
      status: "loaded",
      rawChars: "Current state\n- keep it scoped\n".length,
      injectedChars: "Current state\n- keep it scoped\n".length,
    });
  });

  it("truncates scoped working memory to fit the configured prompt budget", () => {
    const fitted = fitScopedWorkingMemoryContextFileToBudget({
      loaded: {
        contextFile: {
          path: ".openclaw/working-memory/cron/nightly.md",
          content: "abcdefghijklmnopqrstuvwxyz",
        },
        file: {
          path: ".openclaw/working-memory/cron/nightly.md",
          status: "loaded",
          rawChars: 26,
          injectedChars: 26,
        },
      },
      maxChars: 10,
      totalMaxChars: 1_000,
    });

    expect(fitted.contextFile).toEqual({
      path: ".openclaw/working-memory/cron/nightly.md",
      content: "abcdefghij",
    });
    expect(fitted.file).toEqual({
      path: ".openclaw/working-memory/cron/nightly.md",
      status: "loaded",
      rawChars: 26,
      injectedChars: 10,
    });
  });

  it("marks scoped working memory as present-not-injected when prompt budget is exhausted", () => {
    const fitted = fitScopedWorkingMemoryContextFileToBudget({
      loaded: {
        contextFile: {
          path: ".openclaw/working-memory/cron/nightly.md",
          content: "abcdefghijklmnopqrstuvwxyz",
        },
        file: {
          path: ".openclaw/working-memory/cron/nightly.md",
          status: "loaded",
          rawChars: 26,
          injectedChars: 26,
        },
      },
      maxChars: 26,
      totalMaxChars: 100,
    });

    const stats = buildScopedWorkingMemoryInjectionStats([fitted.file]);
    expect(fitted.contextFile).toBeUndefined();
    expect(fitted.file).toEqual({
      path: ".openclaw/working-memory/cron/nightly.md",
      status: "present-not-injected",
      rawChars: 26,
      injectedChars: 0,
      reason: "budget",
    });
    expect(stats).toEqual([
      {
        name: "nightly.md",
        path: ".openclaw/working-memory/cron/nightly.md",
        missing: false,
        rawChars: 26,
        injectedChars: 0,
        truncated: true,
      },
    ]);
  });
});
