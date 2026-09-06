// Regression tests for managed dreaming Markdown filesystem safety.
import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const MEMORY_DREAMING_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dreaming markdown filesystem safety", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("completes oversized streaming replacements after short writes", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: short-write update";
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      startMarker,
      "- Old candidate",
      endMarker,
      "Tail stays.",
    ].join("\n");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(inlinePath, original, "utf-8");

    let shortWriteCount = 0;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openPath, ...rest) => {
      const handle = await originalOpen(openPath, ...rest);
      const rawWrite = handle.write.bind(handle) as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let injected = false;
      handle.write = (async (...args: unknown[]) => {
        const [data, offset, length, position] = args;
        if (
          !injected &&
          Buffer.isBuffer(data) &&
          typeof offset === "number" &&
          typeof length === "number" &&
          typeof position === "number" &&
          length > 1
        ) {
          injected = true;
          shortWriteCount += 1;
          const partialArgs = [...args];
          partialArgs[2] = Math.max(1, Math.floor(length / 2));
          return await rawWrite(...partialArgs);
        }
        return await rawWrite(...args);
      }) as typeof handle.write;
      return handle;
    });

    try {
      await writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: [body],
        nowMs,
        timezone,
        storage: { mode: "inline", separateReports: false },
      });

      expect(shortWriteCount).toBeGreaterThan(0);
      await expect(fs.readFile(inlinePath, "utf-8")).resolves.toBe(
        withTrailingNewline(
          replaceManagedMarkdownBlock({
            original,
            heading: "## Light Sleep",
            startMarker,
            endMarker,
            body,
          }),
        ),
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it("rejects daily memory symlinks under an external memory parent", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const memoryDir = path.join(workspaceDir, "memory");
    const externalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-external-memory`,
    );
    const externalPath = path.join(externalMemoryDir, "targets", "2026-04-05.md");
    await fs.mkdir(externalMemoryDir, { recursive: true });
    await fs.symlink(externalMemoryDir, memoryDir);

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Must not write through an external memory parent"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow("outside workspace memory directory");
      await expect(fs.access(externalPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(memoryDir, { force: true });
      await fs.rm(externalMemoryDir, { force: true, recursive: true });
    }
  });

  it("rejects a parent-directory swap before an oversized final commit", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-race-");
    const memoryDir = path.join(workspaceDir, "memory");
    const originalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-memory-original`,
    );
    const externalMemoryDir = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-external-memory`,
    );
    const inlinePath = path.join(memoryDir, "2026-04-05.md");
    const externalPath = path.join(externalMemoryDir, "2026-04-05.md");
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- Old candidate",
      "<!-- openclaw:dreaming:light:end -->",
      "Tail stays.",
    ].join("\n");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(externalMemoryDir, { recursive: true });
    await fs.writeFile(inlinePath, original, "utf-8");
    await fs.writeFile(externalPath, original, "utf-8");

    let swapTriggered = false;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (openPath, ...rest) => {
      const handle = await originalOpen(openPath, ...rest);
      if (
        !swapTriggered &&
        typeof openPath === "string" &&
        openPath !== inlinePath &&
        path.basename(openPath) === path.basename(inlinePath)
      ) {
        const rawSync = handle.sync.bind(handle) as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>;
        handle.sync = (async (...args: unknown[]) => {
          if (!swapTriggered) {
            swapTriggered = true;
            await fs.rename(memoryDir, originalMemoryDir);
            await fs.symlink(externalMemoryDir, memoryDir);
          }
          return await rawSync(...args);
        }) as typeof handle.sync;
      }
      return handle;
    });

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: parent swap must not redirect the commit"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow();
      expect(swapTriggered).toBe(true);
      await expect(fs.readFile(externalPath, "utf-8")).resolves.toBe(original);
    } finally {
      openSpy.mockRestore();
      if (swapTriggered) {
        await fs.rm(memoryDir, { force: true, recursive: true });
        await fs.rename(originalMemoryDir, memoryDir);
      }
      await fs.rm(externalMemoryDir, { force: true, recursive: true });
    }

    await expect(fs.readFile(inlinePath, "utf-8")).resolves.toBe(original);
  });

  it("surfaces oversized streaming temporary-directory cleanup failures", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-cleanup-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Old candidate",
        "<!-- openclaw:dreaming:light:end -->",
      ].join("\n"),
      "utf-8",
    );

    const realRm = fs.rm;
    let tempDir: string | undefined;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (typeof target === "string" && options?.recursive === true) {
        tempDir = target;
        throw new Error("streaming temp cleanup failed");
      }
      return await realRm(target, options);
    });

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: cleanup failure is visible"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
      ).rejects.toThrow("streaming temp cleanup failed");
      expect(tempDir).toBeDefined();
    } finally {
      rmSpy.mockRestore();
      if (tempDir) {
        await realRm(tempDir, { force: true, recursive: true });
      }
    }
  });
});
