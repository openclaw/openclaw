import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClaudeAppServerBinding } from "./app-server/thread-store.js";
import { createClaudeCommand, handleClaudeCommand } from "./commands.js";

function makeCtx(overrides: Partial<Parameters<typeof handleClaudeCommand>[0]> = {}) {
  return {
    channel: "discord",
    isAuthorizedSender: true,
    commandBody: "/claude",
    config: {},
    ...overrides,
  } as unknown as Parameters<typeof handleClaudeCommand>[0];
}

describe("createClaudeCommand", () => {
  it("registers a reserved /claude command that accepts args", () => {
    const def = createClaudeCommand();
    expect(def.name).toBe("claude");
    expect(def.acceptsArgs).toBe(true);
    expect(def.requireAuth).toBe(true);
    expect(def.ownership).toBe("reserved");
  });
});

describe("/claude subcommand routing", () => {
  it("defaults to help when no args are supplied", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "" }));
    expect(result.text).toContain("Inspect and control");
    expect(result.text).toContain("`status`");
  });

  it("routes 'help' explicitly", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "help" }));
    expect(result.text).toContain("Subcommands:");
  });

  it("returns status without spawning the shared client when no turn has run", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "status" }));
    expect(result.text).toContain("Claude app-server status");
    expect(result.text).toContain("not yet created");
  });

  it("reports plugin, minimum-required, bundled, and running bridge versions", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "version" }));
    expect(result.text).toContain("Claude harness versions");
    expect(result.text).toContain("Minimum bridge required:");
    // Running line is present even when no turn has run ("not running"); the
    // bundled line tolerates an absent managed binary so the test stays
    // hermetic without a real install.
    expect(result.text).toContain("Running bridge (spawned):");
    expect(result.text).toContain("Bundled bridge (managed):");
  });

  it("threads: reports missing-session when no sessionFile is bound", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "threads" }));
    expect(result.text).toContain("No session file is bound");
  });

  it("resume: requires a thread_id argument", async () => {
    const result = await handleClaudeCommand(
      makeCtx({ args: "resume", sessionFile: "/tmp/example.jsonl" }),
    );
    expect(result.text).toContain("Usage: `/claude resume <thread_id>`");
  });
});

describe("/claude threads + resume against a real binding sidecar", () => {
  let dir: string;
  let sessionFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-cmd-test-"));
    sessionFile = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("threads: prints a 'no binding' note when the sidecar is missing", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "threads", sessionFile }));
    expect(result.text).toContain("No claude binding sidecar");
  });

  it("threads: prints the binding contents when present", async () => {
    await writeClaudeAppServerBinding(sessionFile, {
      threadId: "thr_test_abc",
      cwd: dir,
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
    });
    const result = await handleClaudeCommand(makeCtx({ args: "threads", sessionFile }));
    expect(result.text).toContain("`thr_test_abc`");
    expect(result.text).toContain("claude-sonnet-4-6");
  });

  it("resume: writes a fresh binding when none exists", async () => {
    const result = await handleClaudeCommand(makeCtx({ args: "resume thr_new_xyz", sessionFile }));
    expect(result.text).toContain("Rebound session to thread `thr_new_xyz`");
    const after = await handleClaudeCommand(makeCtx({ args: "threads", sessionFile }));
    expect(after.text).toContain("`thr_new_xyz`");
  });

  it("resume: preserves existing binding fields when rotating thread id", async () => {
    await writeClaudeAppServerBinding(sessionFile, {
      threadId: "thr_old",
      cwd: dir,
      model: "claude-sonnet-4-6",
      approvalPolicy: "on-request",
    });
    await handleClaudeCommand(makeCtx({ args: "resume thr_new", sessionFile }));
    const after = await handleClaudeCommand(makeCtx({ args: "threads", sessionFile }));
    expect(after.text).toContain("`thr_new`");
    expect(after.text).toContain("claude-sonnet-4-6");
    expect(after.text).toContain("on-request");
  });
});
