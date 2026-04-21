import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areSessionSummaryDailyMemoryDependenciesCurrent,
  filterOutSessionSummaryDailyMemoryFiles,
  isLikelyMissingSessionSummaryDailyMemory,
  isLikelySessionSummaryDailyMemorySnippet,
  isSessionSummaryDailyMemory,
  isSessionSummaryDailyMemoryPath,
  SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
  type SessionSummaryDailyMemoryDependency,
} from "./daily-content.js";
import { readRememberedDailyMemoryFile, rememberRecentDailyMemoryFile } from "./daily-files.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("daily-content", () => {
  it("detects session-summary bookkeeping content", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 America/New_York",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: abc123",
          "- **Source**: cli",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(isSessionSummaryDailyMemory("# Notes\n\nRegular daily memory.")).toBe(false);
  });

  it("detects legacy pre-sentinel session summaries", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 UTC",
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: abc123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "user: Please keep this summary",
          "assistant: bookkeeping only",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("detects legacy pre-sentinel session summaries without a recovered conversation block", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 UTC",
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: abc123",
          "- **Source**: cli",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("does not treat dated hand-written session notes as legacy bookkeeping without stronger generated-session evidence", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: 2026-04-19 10:00:00 UTC",
          "",
          "- **Session Key**: planning-retro",
          "- **Session ID**: retro-2026-04-19",
          "- **Source**: notes",
          "",
          "## Durable Notes",
          "",
          "- Finalized roadmap priorities.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("does not classify user-authored session notes without the sentinel as bookkeeping", () => {
    expect(
      isSessionSummaryDailyMemory(
        [
          "# Session: Spring planning retrospective",
          "",
          "- **Session Key**: planning-retro",
          "- **Session ID**: retro-2026-04-19",
          "- **Source**: notes",
          "",
          "## Durable Notes",
          "",
          "- Finalized roadmap priorities.",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("does not treat ordinary 'Conversation Summary:' snippets as deleted session summaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-summary-label-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-customer-call.md",
        cache: new Map(),
        snippet: "Conversation Summary: customer prefers Tuesday flights",
        startLine: 3,
      }),
    ).resolves.toBe(false);
  });

  it("does not treat ordinary '## Conversation Summary' headings in missing slugged notes as deleted summaries", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-daily-content-summary-heading-"),
    );
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-customer-call.md",
        cache: new Map(),
        snippet: "## Conversation Summary",
        startLine: 3,
      }),
    ).resolves.toBe(false);
  });

  it("does not treat ordinary prose mentioning session id and session key as deleted summaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-session-keys-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-api-notes.md",
        cache: new Map(),
        snippet: "Need to persist session ID and session key in debug logs.",
        startLine: 12,
      }),
    ).resolves.toBe(false);
  });

  it("keeps missing semantic slugs durable by default but can opt into the legacy transcript fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-legacy-slug-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "assistant: bookkeeping only",
        startLine: 9,
      }),
    ).resolves.toBe(false);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "assistant: bookkeeping only",
        startLine: 9,
        allowLegacySemanticSlugTranscriptFallback: true,
      }),
    ).resolves.toBe(true);
  });

  it("records consulted dependencies so callers can invalidate cache entries after in-place edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-deps-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    const notePath = path.join(root, "memory", "2026-04-19.md");
    await fs.writeFile(notePath, "Durable planning note.\n", "utf-8");

    const dependencies: SessionSummaryDailyMemoryDependency[] = [];
    const canonicalNotePath = await fs.realpath(notePath);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19.md",
        cache: new Map(),
        snippet: "Durable planning note.",
        startLine: 1,
        recordDependency: (dependency) => {
          dependencies.push(dependency);
        },
      }),
    ).resolves.toBe(false);
    expect(dependencies).toEqual([
      expect.objectContaining({
        kind: "file",
        absolutePath: canonicalNotePath,
      }),
    ]);
    await expect(areSessionSummaryDailyMemoryDependenciesCurrent(dependencies)).resolves.toBe(true);

    await fs.writeFile(
      notePath,
      [
        "# Session: 2026-04-19 10:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
      ].join("\n") + "\n",
      "utf-8",
    );

    await expect(areSessionSummaryDailyMemoryDependenciesCurrent(dependencies)).resolves.toBe(
      false,
    );
  });

  it("invalidates file dependencies when contents change without changing size or mtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-deps-same-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    const notePath = path.join(root, "memory", "2026-04-19.md");
    const stableMtime = new Date("2026-04-19T10:00:00.000Z");
    const initialContent = "Durable planning note.\n";
    const updatedContent = "Session planning note.\n";
    expect(initialContent.length).toBe(updatedContent.length);
    await fs.writeFile(notePath, initialContent, "utf-8");
    await fs.utimes(notePath, stableMtime, stableMtime);

    const dependencies: SessionSummaryDailyMemoryDependency[] = [];
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19.md",
        cache: new Map(),
        snippet: "Durable planning note.",
        startLine: 1,
        recordDependency: (dependency) => {
          dependencies.push(dependency);
        },
      }),
    ).resolves.toBe(false);
    await expect(areSessionSummaryDailyMemoryDependenciesCurrent(dependencies)).resolves.toBe(true);

    await fs.writeFile(notePath, updatedContent, "utf-8");
    await fs.utimes(notePath, stableMtime, stableMtime);

    await expect(areSessionSummaryDailyMemoryDependenciesCurrent(dependencies)).resolves.toBe(
      false,
    );
  });

  it("does not probe sibling daily files outside the workspace boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-boundary-root-"));
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-daily-content-boundary-outside-"),
    );
    tmpDirs.push(root, outside);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(path.join(outside, "2026-04-19.md"), "outside durable note\n", "utf-8");

    const dependencies: SessionSummaryDailyMemoryDependency[] = [];
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: path.join(outside, "2026-04-19-missing.md"),
        cache: new Map(),
        snippet: "assistant: transcript-like",
        startLine: 1,
        recordDependency: (dependency) => {
          dependencies.push(dependency);
        },
      }),
    ).resolves.toBe(false);
    expect(dependencies).toEqual([]);
  });

  it("does not follow symlinked daily-note probes outside the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-symlink-root-"));
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-daily-content-symlink-outside-"),
    );
    tmpDirs.push(root, outside);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    const outsideFile = path.join(outside, "2026-04-19-note.md");
    await fs.writeFile(
      outsideFile,
      [
        "# Session: 2026-04-19 10:00:00 UTC",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "assistant: outside",
      ].join("\n"),
      "utf-8",
    );
    await fs.symlink(outsideFile, path.join(root, "memory", "2026-04-19-note.md"));

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-note.md",
        cache: new Map(),
        snippet: "assistant: outside",
        startLine: 1,
      }),
    ).resolves.toBe(false);
  });

  it("requires stronger evidence than transcript-like snippets for missing slugged notes", () => {
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19-session-reset.md",
        snippet: "assistant: we should follow up with the vendor tomorrow",
      }),
    ).toBe(false);
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19-password-reset.md",
        snippet: "assistant: we should follow up with the vendor tomorrow",
      }),
    ).toBe(false);
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19-session-plan.md",
        snippet: "assistant: we should follow up with the vendor tomorrow",
      }),
    ).toBe(false);
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19-session-reset.md",
        snippet: "# Session: 2026-04-19 10:00:00 UTC",
      }),
    ).toBe(true);
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19-session-reset.md",
        snippet: "## Conversation Summary",
      }),
    ).toBe(false);
  });

  it("does not treat canonical deleted notes as bookkeeping from a conversation-summary heading alone", () => {
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19.md",
        snippet: "## Conversation Summary",
      }),
    ).toBe(false);
    expect(
      isLikelyMissingSessionSummaryDailyMemory({
        filePath: "memory/2026-04-19.md",
        snippet: "# Session: 2026-04-19 10:00:00 UTC",
      }),
    ).toBe(true);
  });

  it("classifies transcript-like or metadata snippets as session-summary-like without relying on slug provenance", () => {
    expect(isLikelySessionSummaryDailyMemorySnippet("assistant: bookkeeping only")).toBe(true);
    expect(isLikelySessionSummaryDailyMemorySnippet("## Conversation Summary")).toBe(true);
    expect(
      isLikelySessionSummaryDailyMemorySnippet("Need to follow up with the vendor tomorrow."),
    ).toBe(false);
  });

  it("filters session-summary bookkeeping files out of grounded-memory inputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-"));
    tmpDirs.push(root);
    const notePath = path.join(root, "2026-04-19.md");
    const sessionSummaryPath = path.join(root, "2026-04-19-session-reset.md");
    await fs.writeFile(notePath, "## Durable Notes\n\nKeep this.\n", "utf-8");
    await fs.writeFile(
      sessionSummaryPath,
      [
        "# Session: 2026-04-19 10:00:00 America/New_York",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
        "",
        "assistant: bookkeeping only",
      ].join("\n") + "\n",
      "utf-8",
    );

    await expect(
      filterOutSessionSummaryDailyMemoryFiles([notePath, sessionSummaryPath]),
    ).resolves.toEqual([notePath]);
  });

  it("skips unreadable daily files while filtering bookkeeping files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-unreadable-"));
    tmpDirs.push(root);
    const notePath = path.join(root, "2026-04-19.md");
    const unreadablePath = path.join(root, "2026-04-20.md");
    await fs.writeFile(notePath, "## Durable Notes\n\nKeep this.\n", "utf-8");
    await fs.writeFile(unreadablePath, "## Hidden Notes\n\nSkip this.\n", "utf-8");

    const originalReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const resolvedTarget =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf-8")
            : target instanceof URL
              ? target.pathname
              : "";
      if (path.resolve(resolvedTarget) === unreadablePath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return await originalReadFile(target, options);
    });

    try {
      await expect(
        filterOutSessionSummaryDailyMemoryFiles([notePath, unreadablePath]),
      ).resolves.toEqual([notePath]);
    } finally {
      readFile.mockRestore();
    }
  });

  it("surfaces unreadable daily files when error tolerance is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-strict-"));
    tmpDirs.push(root);
    const notePath = path.join(root, "2026-04-19.md");
    const unreadablePath = path.join(root, "2026-04-20.md");
    await fs.writeFile(notePath, "## Durable Notes\n\nKeep this.\n", "utf-8");
    await fs.writeFile(unreadablePath, "## Hidden Notes\n\nStop here.\n", "utf-8");

    const originalReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const resolvedTarget =
        typeof target === "string"
          ? target
          : Buffer.isBuffer(target)
            ? target.toString("utf-8")
            : target instanceof URL
              ? target.pathname
              : "";
      if (path.resolve(resolvedTarget) === unreadablePath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return await originalReadFile(target, options);
    });

    try {
      await expect(
        filterOutSessionSummaryDailyMemoryFiles([notePath, unreadablePath], {
          tolerateReadErrors: false,
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      readFile.mockRestore();
    }
  });

  it("keeps missing slugged snippets when a same-day sibling still contains the snippet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-sibling-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19.md"),
      "We should follow up with the vendor tomorrow.\n",
      "utf-8",
    );

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("does not treat transcript-like snippets as deleted summaries when a durable sibling matches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-transcript-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19.md"),
      "assistant: transcript-like\n",
      "utf-8",
    );

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "assistant: transcript-like",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("does not treat legacy basename transcript-like snippets as deleted summaries when a memory sibling matches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-basename-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19.md"),
      "assistant: transcript-like\n",
      "utf-8",
    );

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "assistant: transcript-like",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("does not let stale remembered bookkeeping provenance override live same-day siblings", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-daily-content-remembered-sibling-"),
    );
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19.md"),
      "We should follow up with the vendor tomorrow.\n",
      "utf-8",
    );
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("does not let bookkeeping siblings force deleted-summary fallback matching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-bookkeeping-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-04-19-session-reset.md"),
      [
        "# Session: 2026-04-19 10:00:00 America/New_York",
        "",
        SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: abc123",
        "- **Source**: cli",
        "",
        "## Conversation Summary",
        "",
        "We should follow up with the vendor tomorrow.",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("treats remembered semantic session-summary slugs as deleted bookkeeping files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-remembered-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
  });

  it("refreshes stale remembered bookkeeping provenance before trusting missing-file fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-refresh-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(memoryDir, "2026-04-19.md"), "durable note\n", "utf-8");

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "ordinary durable note",
        startLine: 11,
      }),
    ).resolves.toBe(false);
    await expect(
      readRememberedDailyMemoryFile({
        memoryDir,
        fileName: "2026-04-19-vendor-pitch.md",
      }),
    ).resolves.toBeNull();
  });

  it("applies remembered session-summary provenance to basename and absolute-path aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-aliases-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });
    const windowsAbsoluteAlias = "C:/Users/example/workspace/memory/2026-04-19-vendor-pitch.md";

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "2026-04-19-vendor-pitch.md",
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: path.join(root, "memory", "2026-04-19-vendor-pitch.md"),
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: windowsAbsoluteAlias,
        cache: new Map(),
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
  });

  it("does not apply remembered root-memory provenance to nested workspace paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-nested-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(path.join(memoryDir, "daily"), { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });

    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: path.join(memoryDir, "daily", "2026-04-19-vendor-pitch.md"),
        cache: new Map(),
        snippet: "ordinary durable note",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });

  it("does not poison the shared alias cache for missing remembered summaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-cache-"));
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19-vendor-pitch.md",
      sessionSummary: true,
    });

    const cache = new Map<string, boolean>();
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "2026-04-19-vendor-pitch.md",
        cache,
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-vendor-pitch.md",
        cache,
        snippet: "We should follow up with the vendor tomorrow.",
        startLine: 11,
      }),
    ).resolves.toBe(true);
  });

  it("keeps missing remembered canonical summaries classified as bookkeeping on later alias probes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-daily-content-canonical-cache-"),
    );
    tmpDirs.push(root);
    const memoryDir = path.join(root, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await rememberRecentDailyMemoryFile({
      memoryDir,
      fileName: "2026-04-19.md",
      sessionSummary: true,
    });

    const cache = new Map<string, boolean>();
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19.md",
        cache,
        snippet: "assistant: transcript-like",
        startLine: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19.md",
        cache,
        snippet: "assistant: transcript-like",
        startLine: 1,
      }),
    ).resolves.toBe(true);
  });

  it("does not cache snippet-driven deleted-summary guesses for missing files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-content-snippet-cache-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });

    const cache = new Map<string, boolean>();
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-note.md",
        cache,
        snippet: "# Session: 2026-04-19 10:00:00 UTC",
        startLine: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      isSessionSummaryDailyMemoryPath({
        workspaceDir: root,
        filePath: "memory/2026-04-19-note.md",
        cache,
        snippet: "ordinary durable note",
        startLine: 11,
      }),
    ).resolves.toBe(false);
  });
});
