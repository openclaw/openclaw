import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBlacklistBackend,
  getAllKeywords,
  initDefaultKeywordsFile,
  parseKeywordsFile,
} from "./builtin-blacklist-connector.js";
import type { BlacklistConfig } from "./config.js";

// Mock resolveStateDir to use a temp directory
vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/oc-test-state",
}));

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeConfig(overrides: Partial<BlacklistConfig> = {}): BlacklistConfig {
  return {
    blacklistFile: false,
    caseSensitive: false,
    hot: false,
    hotDebounceMs: 300,
    ...overrides,
  };
}

// ── parseKeywordsFile ───────────────────────────────────────────────────

describe("parseKeywordsFile", () => {
  it("parses keywords with level sections", () => {
    const content = `
[level:critical]
rm -rf /
[level:high]
badword
[level:medium]
sensitive
[level:low]
edge
`;
    const result = parseKeywordsFile(content, noopLogger);
    expect(result.get("critical")).toEqual(["rm -rf /"]);
    expect(result.get("high")).toEqual(["badword"]);
    expect(result.get("medium")).toEqual(["sensitive"]);
    expect(result.get("low")).toEqual(["edge"]);
  });

  it("defaults to medium before first section marker", () => {
    const content = `
defaultword
[level:high]
highword
`;
    const result = parseKeywordsFile(content, noopLogger);
    expect(result.get("medium")).toEqual(["defaultword"]);
    expect(result.get("high")).toEqual(["highword"]);
  });

  it("section markers are case-insensitive", () => {
    const content = `[Level:HIGH]\nhighword\n[LEVEL:Critical]\ncritword`;
    const result = parseKeywordsFile(content, noopLogger);
    expect(result.get("high")).toEqual(["highword"]);
    expect(result.get("critical")).toEqual(["critword"]);
  });

  it("warns on invalid level and defaults to medium", () => {
    const warnSpy = vi.fn();
    const logger = { info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const content = `[level:extreme]\nbadlevel`;
    const result = parseKeywordsFile(content, logger);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("extreme"));
    expect(result.get("medium")).toEqual(["badlevel"]);
  });

  it("ignores comments and empty lines", () => {
    const content = `# comment\n\n[level:high]\n# another comment\nkeyword\n`;
    const result = parseKeywordsFile(content, noopLogger);
    expect(result.get("high")).toEqual(["keyword"]);
  });

  it("handles empty content", () => {
    const result = parseKeywordsFile("", noopLogger);
    for (const level of ["low", "medium", "high", "critical"] as const) {
      expect(result.get(level)).toEqual([]);
    }
  });
});

// ── getAllKeywords ──────────────────────────────────────────────────────

describe("getAllKeywords", () => {
  it("collects all keywords from all levels", () => {
    const levelMap = new Map([
      ["low" as const, ["lowword"]],
      ["medium" as const, ["medword"]],
      ["high" as const, ["highword"]],
      ["critical" as const, ["critword"]],
    ]);
    const result = getAllKeywords(levelMap);
    expect(result).toContain("lowword");
    expect(result).toContain("medword");
    expect(result).toContain("highword");
    expect(result).toContain("critword");
    expect(result).toHaveLength(4);
  });

  it("returns empty array for empty map", () => {
    const levelMap = new Map([
      ["low" as const, []],
      ["medium" as const, []],
      ["high" as const, []],
      ["critical" as const, []],
    ]);
    expect(getAllKeywords(levelMap)).toEqual([]);
  });
});

// ── initDefaultKeywordsFile ─────────────────────────────────────────────

describe("initDefaultKeywordsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oc-init-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  it("copies default file when target does not exist", () => {
    const target = path.join(tmpDir, "guardrails", "keywords.txt");
    initDefaultKeywordsFile(target, noopLogger);
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf8");
    expect(content).toContain("[level:critical]");
    expect(content).toContain("rm -rf /");
  });

  it("does not overwrite existing file", () => {
    const target = path.join(tmpDir, "keywords.txt");
    writeFileSync(target, "custom content");
    initDefaultKeywordsFile(target, noopLogger);
    expect(readFileSync(target, "utf8")).toBe("custom content");
  });

  it("warns and leaves target missing when bundled template is unavailable", () => {
    const target = path.join(tmpDir, "guardrails", "keywords.txt");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    initDefaultKeywordsFile(target, logger, null);

    expect(logger.warn).toHaveBeenCalledWith(
      "guardrails: default keywords template not found; starting with empty blacklist until a keywords file is provided",
    );
    expect(existsSync(target)).toBe(false);
  });

  it("warns and leaves target missing when default template copy fails", () => {
    const source = path.join(tmpDir, "keywords.default.txt");
    const target = path.join(tmpDir, "guardrails", "keywords.txt");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    writeFileSync(source, "[level:high]\nbadword\n");
    writeFileSync(path.join(tmpDir, "guardrails"), "not a directory");

    expect(() => initDefaultKeywordsFile(target, logger, source)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("guardrails: failed to initialize default keywords file"),
    );
    expect(existsSync(target)).toBe(false);
  });
});

// ── createBlacklistBackend — basic matching ─────────────────────────────

describe("builtin-blacklist-connector — basic matching", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oc-bl-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  it("blocks keyword found in text", async () => {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, "[level:high]\nbadword\n");

    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Blocked",
      noopLogger,
    );
    const result = await backendFn("this has badword in it", {});
    expect(result.action).toBe("block");
    expect(result.metadata?.matchedKeyword).toBe("badword");
  });

  it("passes when no keyword matches", async () => {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, "[level:high]\nbadword\n");

    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Blocked",
      noopLogger,
    );
    const result = await backendFn("this is clean text", {});
    expect(result.action).toBe("pass");
  });

  it("loads keywords from all levels", async () => {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, "[level:critical]\ncritword\n[level:low]\nlowword\n");

    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Blocked",
      noopLogger,
    );
    // Both critical and low level keywords are matched
    expect((await backendFn("has critword", {})).action).toBe("block");
    expect((await backendFn("has lowword", {})).action).toBe("block");
  });

  it("passes when no keywords loaded", async () => {
    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: false }),
      "Blocked",
      noopLogger,
    );
    expect((await backendFn("anything", {})).action).toBe("pass");
  });

  it("empty string input → pass", async () => {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, "[level:high]\nbadword\n");

    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Blocked",
      noopLogger,
    );
    expect((await backendFn("", {})).action).toBe("pass");
  });

  it("block result carries blockMessage from config", async () => {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, "[level:high]\nbadword\n");

    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Custom block message",
      noopLogger,
    );
    const result = await backendFn("this has badword", {});
    expect(result.action).toBe("block");
    expect(result.blockMessage).toBe("Custom block message");
  });
});

// ── Unicode normalization bypass ────────────────────────────────────────

describe("builtin-blacklist-connector — Unicode normalization bypass", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oc-bl-norm-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  function makeBackend(keywords: string) {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, `[level:high]\n${keywords}\n`);
    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath }),
      "Blocked",
      noopLogger,
    );
    return backendFn;
  }

  it.each([
    ["fullwidth", "bad", "ｂａｄ content"],
    ["zero-width space", "badword", "bad\u200Bword inserted"],
    ["combined fullwidth+zero-width", "badword", "ｂａｄ\u200Bｗｏｒｄ"],
    ["Chinese with zero-width", "违禁品", "违\u200B禁\u200B品"],
  ])("blocks %s bypass", async (_label, keyword, input) => {
    expect((await makeBackend(keyword)(input, {})).action).toBe("block");
  });
});

// ── File loading ────────────────────────────────────────────────────────

describe("builtin-blacklist-connector — file loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oc-bl-file-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  it("skips silently when file does not exist", () => {
    const { backendFn: _ } = createBlacklistBackend(
      makeConfig({ blacklistFile: "/nonexistent/path.txt" }),
      "Blocked",
      noopLogger,
    );
    expect(noopLogger.error).not.toHaveBeenCalled();
  });

  it("logs error for unreadable file (non-ENOENT)", () => {
    const logErrorSpy = vi.spyOn(noopLogger, "error");
    // Pass a directory path (unreadable as file)
    createBlacklistBackend(makeConfig({ blacklistFile: tmpDir }), "Blocked", noopLogger);
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to read blacklist file"),
    );
  });

  it("returns pass when blacklistFile=false", async () => {
    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: false }),
      "Blocked",
      noopLogger,
    );
    expect((await backendFn("anything", {})).action).toBe("pass");
  });
});

// ── Case sensitivity ────────────────────────────────────────────────────

describe("builtin-blacklist-connector — case sensitivity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `oc-bl-case-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  function makeBackend(keywords: string, caseSensitive: boolean) {
    const filePath = path.join(tmpDir, "kw.txt");
    writeFileSync(filePath, `[level:high]\n${keywords}\n`);
    const { backendFn } = createBlacklistBackend(
      makeConfig({ blacklistFile: filePath, caseSensitive }),
      "Blocked",
      noopLogger,
    );
    return backendFn;
  }

  it("caseSensitive=false — matches uppercase input against lowercase keyword", async () => {
    const fn = makeBackend("badword", false);
    expect((await fn("BADWORD here", {})).action).toBe("block");
  });

  it("caseSensitive=true — does NOT match wrong case", async () => {
    const fn = makeBackend("BadWord", true);
    expect((await fn("badword here", {})).action).toBe("pass");
  });

  it("caseSensitive=true — matches exact case", async () => {
    const fn = makeBackend("BadWord", true);
    expect((await fn("BadWord here", {})).action).toBe("block");
  });

  it("caseSensitive=true — uppercase keyword does not match lowercase input", async () => {
    const fn = makeBackend("DANGER", true);
    expect((await fn("danger zone", {})).action).toBe("pass");
    expect((await fn("DANGER zone", {})).action).toBe("block");
  });
});

// ── Dispose ─────────────────────────────────────────────────────────────

describe("builtin-blacklist-connector — dispose", () => {
  it("dispose does not throw when hot=false", () => {
    const { dispose } = createBlacklistBackend(makeConfig(), "Blocked", noopLogger);
    expect(() => dispose()).not.toThrow();
  });
});
