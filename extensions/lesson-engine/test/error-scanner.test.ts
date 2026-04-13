import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyError,
  deriveDomainTags,
  readPersistedSeeds,
  readScannerState,
  scanSession,
  writeScannerState,
  writeSeedsAppend,
} from "../src/error-scanner.js";
import type { ErrorSeed, ScannerState } from "../src/types.js";
import { makeFixture } from "./helpers.js";

// ── Helper to write a mock JSONL session ──

function writeSession(dir: string, filename: string, lines: unknown[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function makeSessionLines(opts: {
  sessionId?: string;
  sessionTimestamp?: string;
  errors?: Array<{
    tool: string;
    error: string;
    timestamp?: number;
    isError?: boolean;
    detailsStatus?: string;
  }>;
}): unknown[] {
  const lines: unknown[] = [];
  lines.push({
    type: "session",
    id: opts.sessionId ?? "sess-001",
    timestamp: opts.sessionTimestamp ?? "2026-04-13T10:00:00Z",
    cwd: "/tmp",
  });

  for (const err of opts.errors ?? []) {
    // Assistant tool call
    lines.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: err.tool, id: `call-${err.tool}`, input: {} }],
      },
    });
    // Tool result with error
    lines.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${err.tool}`,
        toolName: err.tool,
        details: {
          status: err.detailsStatus ?? "error",
          tool: err.tool,
          error: err.error,
        },
        isError: err.isError ?? false,
        timestamp: err.timestamp ?? 1712998800000,
        content: [{ type: "text", text: err.error }],
      },
    });
  }
  return lines;
}

describe("scanSession", () => {
  test("extracts error seeds from a session JSONL", () => {
    const fx = makeFixture();
    try {
      const lines = makeSessionLines({
        sessionId: "sess-abc",
        sessionTimestamp: "2026-04-13T10:00:00Z",
        errors: [
          { tool: "Bash", error: "Permission denied: /etc/shadow" },
          { tool: "Read", error: "ENOENT: no such file or directory" },
        ],
      });
      const sessionPath = writeSession(path.join(fx.root, "sessions"), "sess-abc.jsonl", lines);
      const seeds = scanSession(sessionPath, "builder");

      expect(seeds).toHaveLength(2);
      expect(seeds[0].sessionKey).toBe("sess-abc");
      expect(seeds[0].agent).toBe("builder");
      expect(seeds[0].tool).toBe("Bash");
      expect(seeds[0].errorClass).toBe("Permission denied");
      expect(seeds[1].tool).toBe("Read");
      expect(seeds[1].errorClass).toBe("File not found");
    } finally {
      fx.cleanup();
    }
  });

  test("fingerprint is deterministic for same agent:tool:errorClass", () => {
    const fx = makeFixture();
    try {
      const lines = makeSessionLines({
        errors: [{ tool: "Bash", error: "Permission denied: /etc/shadow" }],
      });
      const p = writeSession(path.join(fx.root, "sessions"), "s1.jsonl", lines);
      const seeds1 = scanSession(p, "builder");

      const lines2 = makeSessionLines({
        sessionId: "sess-002",
        errors: [{ tool: "Bash", error: "Permission denied: /root/.ssh" }],
      });
      const p2 = writeSession(path.join(fx.root, "sessions2"), "s2.jsonl", lines2);
      const seeds2 = scanSession(p2, "builder");

      // Same agent:tool:errorClass => same fingerprint
      expect(seeds1[0].fingerprint).toBe(seeds2[0].fingerprint);
      expect(seeds1[0].fingerprint).toHaveLength(16);
    } finally {
      fx.cleanup();
    }
  });

  test("detects errors via isError flag", () => {
    const fx = makeFixture();
    try {
      const lines: unknown[] = [
        { type: "session", id: "sess-ie", timestamp: "2026-04-13T10:00:00Z", cwd: "/tmp" },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "exec",
            details: {},
            isError: true,
            timestamp: 1712998800000,
            content: [{ type: "text", text: "command failed" }],
          },
        },
      ];
      const p = writeSession(path.join(fx.root, "s"), "ie.jsonl", lines);
      const seeds = scanSession(p, "builder");
      expect(seeds).toHaveLength(1);
      expect(seeds[0].errorMessage).toBe("command failed");
    } finally {
      fx.cleanup();
    }
  });

  test("detects errors via JSON text content with error key", () => {
    const fx = makeFixture();
    try {
      const errJson = JSON.stringify({ status: "error", error: "rate limit exceeded" });
      const lines: unknown[] = [
        { type: "session", id: "sess-jt", timestamp: "2026-04-13T10:00:00Z", cwd: "/tmp" },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "gh",
            details: {},
            isError: false,
            timestamp: 1712998800000,
            content: [{ type: "text", text: errJson }],
          },
        },
      ];
      const p = writeSession(path.join(fx.root, "s"), "jt.jsonl", lines);
      const seeds = scanSession(p, "builder");
      expect(seeds).toHaveLength(1);
      expect(seeds[0].errorClass).toBe("Rate limit");
    } finally {
      fx.cleanup();
    }
  });

  test("returns empty for non-existent file", () => {
    const seeds = scanSession("/nonexistent/path.jsonl", "builder");
    expect(seeds).toEqual([]);
  });
});

describe("domain tags", () => {
  test("bash → cli, error-capture, shell (sorted)", () => {
    const tags = deriveDomainTags("bash");
    expect(tags).toContain("shell");
    expect(tags).toContain("cli");
    expect(tags).toContain("error-capture");
    expect(tags).toEqual([...tags].sort());
  });

  test("read → error-capture, filesystem (sorted)", () => {
    const tags = deriveDomainTags("read");
    expect(tags).toContain("filesystem");
    expect(tags).toContain("error-capture");
    expect(tags).toEqual([...tags].sort());
  });

  test("gh → ci-cd, error-capture, github (sorted)", () => {
    const tags = deriveDomainTags("gh");
    expect(tags).toContain("github");
    expect(tags).toContain("ci-cd");
    expect(tags).toContain("error-capture");
    expect(tags).toEqual([...tags].sort());
  });

  test("feishu_send → error-capture, feishu, messaging (sorted)", () => {
    const tags = deriveDomainTags("feishu_send");
    expect(tags).toContain("messaging");
    expect(tags).toContain("feishu");
    expect(tags).toContain("error-capture");
    expect(tags).toEqual([...tags].sort());
  });

  test("mcp__openclaw__review strips prefix", () => {
    const tags = deriveDomainTags("mcp__openclaw__review");
    expect(tags).toContain("review");
    expect(tags).toContain("error-capture");
    expect(tags).toEqual([...tags].sort());
  });
});

describe("error class extraction", () => {
  test("extracts known patterns", () => {
    expect(classifyError("Permission denied: /etc/shadow")).toBe("Permission denied");
    expect(classifyError("ENOENT: no such file or directory")).toBe("File not found");
    expect(classifyError("Request timed out after 30s")).toBe("Timeout");
    expect(classifyError("rate limit exceeded")).toBe("Rate limit");
  });

  test("extracts from raw connection refused error", () => {
    expect(classifyError("Connection refused to host")).toBe("Connection refused");
    expect(classifyError("ECONNREFUSED 127.0.0.1:3000")).toBe("Connection refused");
  });

  test("truncates long error classes to 80 chars", () => {
    const long = "A".repeat(200);
    expect(classifyError(long).length).toBe(80);
  });
});

describe("scanner state", () => {
  test("read returns empty state when file does not exist", () => {
    const fx = makeFixture();
    try {
      const state = readScannerState(fx.root);
      expect(state.version).toBe(1);
      expect(state.scannedSessions).toEqual({});
    } finally {
      fx.cleanup();
    }
  });

  test("write + read roundtrips", () => {
    const fx = makeFixture();
    try {
      const state: ScannerState = {
        version: 1,
        lastScanAt: "2026-04-13T10:00:00Z",
        scannedSessions: { builder: ["sess-1", "sess-2"] },
      };
      writeScannerState(state, fx.root);
      const loaded = readScannerState(fx.root);
      expect(loaded).toEqual(state);
    } finally {
      fx.cleanup();
    }
  });
});

describe("readPersistedSeeds", () => {
  test("reads seeds from .jsonl files in error-seeds directory", () => {
    const fx = makeFixture();
    try {
      const seedsDir = path.join(fx.root, "shared", "lessons", "error-seeds");
      fs.mkdirSync(seedsDir, { recursive: true });
      const seed1: ErrorSeed = {
        sessionKey: "sess-1",
        agent: "builder",
        tool: "Bash",
        errorClass: "Permission denied",
        errorMessage: "Permission denied: /etc/shadow",
        fingerprint: "abcdef0123456789",
        domainTags: ["shell", "cli", "error-capture"],
        timestamp: "2026-04-13T10:00:00Z",
        sessionTimestamp: "2026-04-13T09:00:00Z",
      };
      const seed2: ErrorSeed = {
        sessionKey: "sess-2",
        agent: "architect",
        tool: "Read",
        errorClass: "File not found",
        errorMessage: "ENOENT: no such file or directory",
        fingerprint: "1234567890abcdef",
        domainTags: ["filesystem", "error-capture"],
        timestamp: "2026-04-13T11:00:00Z",
        sessionTimestamp: "2026-04-13T10:30:00Z",
      };
      fs.writeFileSync(
        path.join(seedsDir, "2026-04-13.jsonl"),
        JSON.stringify(seed1) + "\n" + JSON.stringify(seed2) + "\n",
        "utf8",
      );

      const seeds = readPersistedSeeds(fx.root);
      expect(seeds).toHaveLength(2);
      expect(seeds[0].sessionKey).toBe("sess-1");
      expect(seeds[0].agent).toBe("builder");
      expect(seeds[0].tool).toBe("Bash");
      expect(seeds[1].sessionKey).toBe("sess-2");
      expect(seeds[1].agent).toBe("architect");
      expect(seeds[1].tool).toBe("Read");
    } finally {
      fx.cleanup();
    }
  });

  test("returns empty array when error-seeds dir does not exist", () => {
    const fx = makeFixture();
    try {
      const seeds = readPersistedSeeds(fx.root);
      expect(seeds).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("skips malformed lines", () => {
    const fx = makeFixture();
    try {
      const seedsDir = path.join(fx.root, "shared", "lessons", "error-seeds");
      fs.mkdirSync(seedsDir, { recursive: true });
      const validSeed: ErrorSeed = {
        sessionKey: "sess-1",
        agent: "builder",
        tool: "Bash",
        errorClass: "Timeout",
        errorMessage: "Request timed out",
        fingerprint: "aabb001122334455",
        domainTags: ["error-capture"],
        timestamp: "2026-04-13T10:00:00Z",
        sessionTimestamp: "2026-04-13T09:00:00Z",
      };
      fs.writeFileSync(
        path.join(seedsDir, "2026-04-13.jsonl"),
        "NOT VALID JSON\n" + JSON.stringify(validSeed) + "\n",
        "utf8",
      );

      const seeds = readPersistedSeeds(fx.root);
      expect(seeds).toHaveLength(1);
      expect(seeds[0].errorClass).toBe("Timeout");
    } finally {
      fx.cleanup();
    }
  });
});

describe("writeSeedsAppend", () => {
  test("appends seeds to daily JSONL file", () => {
    const fx = makeFixture();
    try {
      const seed: ErrorSeed = {
        sessionKey: "sess-1",
        agent: "builder",
        tool: "Bash",
        errorClass: "Permission denied",
        errorMessage: "Permission denied: /etc/shadow",
        fingerprint: "abcdef0123456789",
        domainTags: ["shell", "cli", "error-capture"],
        timestamp: "2026-04-13T10:00:00Z",
        sessionTimestamp: "2026-04-13T09:00:00Z",
      };
      const filePath = writeSeedsAppend([seed], fx.root);
      expect(filePath).toBeTruthy();
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionKey).toBe("sess-1");

      // Append more
      writeSeedsAppend([seed], fx.root);
      const content2 = fs.readFileSync(filePath, "utf8");
      expect(content2.trim().split("\n")).toHaveLength(2);
    } finally {
      fx.cleanup();
    }
  });

  test("returns file path even for empty seeds (no append)", () => {
    const fx = makeFixture();
    try {
      const filePath = writeSeedsAppend([], fx.root);
      expect(filePath).toBeTruthy();
      expect(filePath.endsWith(".jsonl")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
