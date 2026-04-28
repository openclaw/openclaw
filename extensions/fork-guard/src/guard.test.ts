import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FORK_GUARD_CONFIG } from "./config.js";
import {
  analyzeExecToolCall,
  findFirstDiffHit,
  formatBlockReason,
  isProtectedCommand,
  matchesBlockedRepo,
  parsePattern,
} from "./guard.js";

const stubCtx = {
  toolName: "exec",
  agentId: "main",
  sessionKey: "agent:main:test",
};

describe("fork-guard helpers", () => {
  it("detects protected commands", () => {
    expect(isProtectedCommand("git push origin HEAD")).toBe(true);
    expect(isProtectedCommand("gh pr create --fill")).toBe(true);
    expect(isProtectedCommand("git status")).toBe(false);
  });

  it("parses regex literals and plain strings", () => {
    expect(parsePattern("/alpaca/i")).toMatchObject({ kind: "regex", raw: "/alpaca/i" });
    expect(parsePattern("/home/damon")).toEqual({
      kind: "string",
      raw: "/home/damon",
      value: "/home/damon",
    });
  });

  it("matches protected repos by remote URL substring", () => {
    expect(
      matchesBlockedRepo(["git@github.com:kami-saia/openclaw.git"], ["kami-saia/openclaw"]),
    ).toBe(true);
    expect(
      matchesBlockedRepo(["git@github.com:openclaw/openclaw.git"], ["kami-saia/openclaw"]),
    ).toBe(false);
  });

  it("finds the first matching added line in a diff and reports file:line", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      " unchanged",
      "+const path = '/home/damon/secret';",
      "+const ok = true;",
    ].join("\n");

    const hit = findFirstDiffHit(diff, ["/home/damon", "/alpaca/i"]);
    expect(hit).toEqual({
      file: "src/a.ts",
      line: 11,
      excerpt: "const path = '/home/damon/secret';",
      pattern: "/home/damon",
    });
    expect(formatBlockReason(hit!)).toBe(
      "fork-guard blocked push/PR: matched /home/damon in src/a.ts:11",
    );
  });
});

describe("analyzeExecToolCall", () => {
  it("ignores non-exec-like commands", async () => {
    const execFile = vi.fn();
    const result = await analyzeExecToolCall({
      event: { toolName: "exec", params: { command: "git status", workdir: "/repo" } },
      ctx: stubCtx,
      config: DEFAULT_FORK_GUARD_CONFIG,
      deps: { execFile },
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("ignores pushes outside protected repos", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "origin\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:openclaw/openclaw.git\n", stderr: "" });

    const result = await analyzeExecToolCall({
      event: {
        toolName: "exec",
        params: { command: "git push origin HEAD", workdir: "/repo" },
      },
      ctx: stubCtx,
      config: DEFAULT_FORK_GUARD_CONFIG,
      deps: { execFile },
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("blocks protected repo pushes when the diff contains a configured plain-string hit", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "origin\nupstream\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:kami-saia/openclaw.git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:openclaw/openclaw.git\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,0 +1,2 @@",
          "+const channel = '1466839871162155171';",
          "+const ok = true;",
        ].join("\n"),
        stderr: "",
      });

    const result = await analyzeExecToolCall({
      event: {
        toolName: "exec",
        params: { command: "git push origin HEAD", workdir: "/repo" },
      },
      ctx: stubCtx,
      config: DEFAULT_FORK_GUARD_CONFIG,
      deps: { execFile },
    });

    expect(result).toEqual({
      block: true,
      blockReason: "fork-guard blocked push/PR: matched 1466839871162155171 in src/a.ts:1",
    });
  });

  it("blocks protected repo PR creation when the diff contains a configured regex hit", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "origin\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://github.com/kami-saia/openclaw.git\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: [
          "diff --git a/src/b.ts b/src/b.ts",
          "--- a/src/b.ts",
          "+++ b/src/b.ts",
          "@@ -4,0 +4,2 @@",
          "+const venue = 'saiabets';",
          "+const ok = true;",
        ].join("\n"),
        stderr: "",
      });

    const result = await analyzeExecToolCall({
      event: {
        toolName: "exec",
        params: { command: "gh pr create --fill", workdir: "/repo" },
      },
      ctx: stubCtx,
      config: DEFAULT_FORK_GUARD_CONFIG,
      deps: { execFile },
    });

    expect(result).toEqual({
      block: true,
      blockReason: "fork-guard blocked push/PR: matched /saiabets/i in src/b.ts:4",
    });
  });

  it("allows protected repo pushes when the diff is clean", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "origin\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://github.com/kami-saia/openclaw.git\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: [
          "diff --git a/src/c.ts b/src/c.ts",
          "--- a/src/c.ts",
          "+++ b/src/c.ts",
          "@@ -1,0 +1,2 @@",
          "+const safe = true;",
          "+const alsoSafe = 'hello';",
        ].join("\n"),
        stderr: "",
      });

    const result = await analyzeExecToolCall({
      event: {
        toolName: "exec",
        params: { command: "git push origin HEAD", workdir: "/repo" },
      },
      ctx: stubCtx,
      config: DEFAULT_FORK_GUARD_CONFIG,
      deps: { execFile },
    });

    expect(result).toBeUndefined();
  });
});
