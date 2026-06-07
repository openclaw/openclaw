import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  resetBootstrapWarningCacheForTest,
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerDuplicateBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "AGENTS.md",
        path: "AGENTS.md",
        content: "duplicate relative hook content",
        missing: false,
      },
      {
        name: "AGENTS.md",
        path: path.join(context.workspaceDir, ".", "AGENTS.md"),
        content: "duplicate absolute hook content",
        missing: false,
      },
    ];
  });
}

function registerBootstrapFileHook(relativePath = "BOOTSTRAP.md") {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "BOOTSTRAP.md",
        path: path.join(context.workspaceDir, relativePath),
        content: "stale ritual",
        missing: false,
      },
    ];
  });
}

async function createHeartbeatAgentsWorkspace() {
  const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
  await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");
  return workspaceDir;
}

function expectHeartbeatExcludedAndAgentsKept(files: WorkspaceBootstrapFile[]) {
  const fileNames = files.map((file) => file.name);
  expect(fileNames).not.toContain("HEARTBEAT.md");
  expect(fileNames).toContain("AGENTS.md");
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    const filePaths = files.map((file) => file.path);
    expect(filePaths).toContain(path.join(workspaceDir, "EXTRA.md"));
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("dedupes hook-injected bootstrap paths relative to the workspace", async () => {
    registerDuplicateBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(agentsPath, "workspace rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agentsFiles = files.filter((file) => file.path === agentsPath);

    expect(agentsFiles).toHaveLength(1);
    expect(agentsFiles[0]?.content).toBe("workspace rules");

    const context = await resolveBootstrapContextForRun({ workspaceDir });
    const agentsContextFiles = context.contextFiles.filter((file) => file.path === agentsPath);
    expect(agentsContextFiles).toHaveLength(1);
    expect(agentsContextFiles[0]?.content).toBe("workspace rules");
  });

  it("ignores stale workspace BOOTSTRAP.md once setup is completed", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".openclaw", "workspace-state.json"),
      `${JSON.stringify({
        version: 1,
        bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
        setupCompletedAt: "2026-05-16T00:00:01.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("keeps BOOTSTRAP.md when setup state cannot be read", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, ".openclaw", "workspace-state.json"), {
      recursive: true,
    });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).toContain("BOOTSTRAP.md");
  });

  it("does not let hooks re-add stale root BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook();
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".openclaw", "workspace-state.json"),
      `${JSON.stringify({
        version: 1,
        bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
        setupCompletedAt: "2026-05-16T00:00:01.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("ignores stale root BOOTSTRAP.md for home-relative workspace paths", async () => {
    registerBootstrapFileHook();
    const parentDir = await makeTempWorkspace("openclaw-bootstrap-home-");
    const workspaceDir = path.join(parentDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".openclaw", "workspace-state.json"),
      `${JSON.stringify({
        version: 1,
        bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
        setupCompletedAt: "2026-05-16T00:00:01.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = parentDir;
    try {
      const files = await resolveBootstrapFilesForRun({ workspaceDir: "~/workspace" });

      expect(files.map((file) => file.name)).toContain("AGENTS.md");
      expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
    }
  });

  it("keeps hook-added nested BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook(path.join("packages", "core", "BOOTSTRAP.md"));
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "packages", "core"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".openclaw", "workspace-state.json"),
      `${JSON.stringify({
        version: 1,
        bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
        setupCompletedAt: "2026-05-16T00:00:01.000Z",
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "packages", "core", "BOOTSTRAP.md"),
      "package ritual",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "BOOTSTRAP.md"),
    );
    expect(files.map((file) => file.path)).not.toContain(path.join(workspaceDir, "BOOTSTRAP.md"));
  });

  it("keeps subagent sessions to project and tool bootstrap files", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-subagent-");
    await Promise.all(
      [
        ["AGENTS.md", "project rules"],
        ["TOOLS.md", "tool rules"],
        ["SOUL.md", "persona"],
        ["IDENTITY.md", "identity"],
        ["USER.md", "user profile"],
        ["MEMORY.md", "memory"],
        ["HEARTBEAT.md", "heartbeat"],
        ["BOOTSTRAP.md", "setup"],
      ].map(([fileName, content]) =>
        fs.writeFile(path.join(workspaceDir, fileName), content, "utf8"),
      ),
    );

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:subagent:worker",
    });

    expect(files.map((file) => file.name)).toStrictEqual(["AGENTS.md", "TOOLS.md"]);
  });

  it("keeps cron sessions on their existing minimal bootstrap files", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-cron-");
    await Promise.all(
      [
        ["AGENTS.md", "project rules"],
        ["TOOLS.md", "tool rules"],
        ["SOUL.md", "persona"],
        ["IDENTITY.md", "identity"],
        ["USER.md", "user profile"],
        ["MEMORY.md", "memory"],
        ["HEARTBEAT.md", "heartbeat"],
        ["BOOTSTRAP.md", "setup"],
      ].map(([fileName, content]) =>
        fs.writeFile(path.join(workspaceDir, fileName), content, "utf8"),
      ),
    );

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:cron:daily:run:run-1",
    });

    expect(files.map((file) => file.name)).toStrictEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
    ]);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("keeps BOOTSTRAP.md available in shared injected context for non-attempt consumers", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");

    const result = await resolveBootstrapContextForRun({ workspaceDir });

    const bootstrapFileNames = result.bootstrapFiles.map((file) => file.name);
    expect(bootstrapFileNames).toContain("BOOTSTRAP.md");
    const contextFileNames = new Set(result.contextFiles.map((file) => path.basename(file.path)));
    expect(contextFileNames.has("BOOTSTRAP.md")).toBe(true);
    expect(contextFileNames.has("AGENTS.md")).toBe(true);
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.map((file) => file.name)).toStrictEqual(["HEARTBEAT.md"]);
    expect(files[0]?.content).toBe("check inbox");
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toStrictEqual([]);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat prompt section is disabled", async () => {
    const workspaceDir = await createHeartbeatAgentsWorkspace();

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    expectHeartbeatExcludedAndAgentsKept(files);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat cadence is disabled", async () => {
    const workspaceDir = await createHeartbeatAgentsWorkspace();

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            heartbeat: {
              every: "0m",
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    expectHeartbeatExcludedAndAgentsKept(files);
  });

  it("keeps HEARTBEAT.md for actual heartbeat runs even when the prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "heartbeat",
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    const fileNames = files.map((file) => file.name);
    expect(fileNames).toContain("HEARTBEAT.md");
  });
});

describe("hasCompletedBootstrapTurn", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "openclaw-bootstrap-turn-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when session file does not exist", async () => {
    expect(await hasCompletedBootstrapTurn(path.join(tmpDir, "missing.jsonl"))).toBe(false);
  });

  it("returns false for empty session files", async () => {
    const sessionFile = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for header-only session files", async () => {
    const sessionFile = path.join(tmpDir, "header-only.jsonl");
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "s1" })}\n`, "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false when no assistant turn has been flushed yet", async () => {
    const sessionFile = path.join(tmpDir, "user-only.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for assistant turns without a recorded full bootstrap marker", async () => {
    const sessionFile = path.join(tmpDir, "assistant-no-marker.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a full bootstrap completion marker exists", async () => {
    const sessionFile = path.join(tmpDir, "full-bootstrap.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false when compaction happened after the last assistant turn", async () => {
    const sessionFile = path.join(tmpDir, "post-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
        JSON.stringify({ type: "compaction", summary: "trimmed" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a later full bootstrap marker happens after compaction", async () => {
    const sessionFile = path.join(tmpDir, "assistant-after-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
        JSON.stringify({ type: "compaction", summary: "trimmed" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "new ask" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "new reply" } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 2 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("ignores malformed JSON lines", async () => {
    const sessionFile = path.join(tmpDir, "malformed.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        "{broken",
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("finds a recent full bootstrap marker even when the scan starts mid-file", async () => {
    const sessionFile = path.join(tmpDir, "large-prefix.jsonl");
    const hugePrefix = "x".repeat(300 * 1024);
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: hugePrefix } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false for symbolic links", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    const linkFile = path.join(tmpDir, "link.jsonl");
    await fs.writeFile(
      realFile,
      `${JSON.stringify({ type: "custom", customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, data: { timestamp: 1 } })}\n`,
      "utf8",
    );
    await fs.symlink(realFile, linkFile);
    expect(await hasCompletedBootstrapTurn(linkFile)).toBe(false);
  });
});

describe("makeBootstrapWarn", () => {
  afterEach(() => {
    resetBootstrapWarningCacheForTest();
  });

  it("deduplicates repeated warnings for the same session and message", () => {
    const warnings: string[] = [];
    const warn = makeBootstrapWarn({
      sessionLabel: "agent:main:test-session",
      warn: (message) => warnings.push(message),
    });

    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:test-session)",
    ]);
  });

  it("keeps warnings distinct across sessions", () => {
    const warnings: string[] = [];
    const first = makeBootstrapWarn({
      sessionLabel: "agent:main:first-session",
      warn: (message) => warnings.push(message),
    });
    const second = makeBootstrapWarn({
      sessionLabel: "agent:main:second-session",
      warn: (message) => warnings.push(message),
    });

    first?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    second?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:first-session)",
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:second-session)",
    ]);
  });

  it("keeps warnings distinct across workspaces with the same session", () => {
    const warnings: string[] = [];
    const first = makeBootstrapWarn({
      sessionLabel: "agent:main:shared-session",
      workspaceDir: "/tmp/workspace-a",
      warn: (message) => warnings.push(message),
    });
    const second = makeBootstrapWarn({
      sessionLabel: "agent:main:shared-session",
      workspaceDir: "/tmp/workspace-b",
      warn: (message) => warnings.push(message),
    });

    first?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    second?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:shared-session)",
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:shared-session)",
    ]);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("defaults to always when the setting is omitted", () => {
    expect(resolveContextInjectionMode({ agents: { defaults: {} } } as never)).toBe("always");
  });

  it("returns the configured continuation-skip mode", () => {
    expect(
      resolveContextInjectionMode({
        agents: { defaults: { contextInjection: "continuation-skip" } },
      } as never),
    ).toBe("continuation-skip");
  });

  it("uses per-agent contextInjection before defaults", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [{ id: "strict", contextInjection: "always" }],
          },
        } as never,
        "strict",
      ),
    ).toBe("always");
  });

  it("falls back to defaults when the agent has no contextInjection override", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "never" },
            list: [{ id: "worker" }],
          },
        } as never,
        "worker",
      ),
    ).toBe("never");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #243 — Synthetic bootstrap path preservation
// Test cases designed by Gem (QA Lead), SE Workflow Run #14 Step 3.
// See nova-mind/tests/TEST-CASES-batch-agent-identity.md for full specification.
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizeBootstrapFiles — synthetic path preservation (PR #243)", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  // TC-243-U-01: db:AGENT/HEARTBEAT.md passes through unchanged
  it("TC-243-U-01: preserves db:AGENT/HEARTBEAT.md synthetic path unchanged", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "HEARTBEAT_DB.md",
          path: "db:AGENT/HEARTBEAT.md",
          content: "heartbeat",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const heartbeat = files.find((f) => f.path === "db:AGENT/HEARTBEAT.md");

    expect(heartbeat?.path).toBe("db:AGENT/HEARTBEAT.md");
    // Must NOT be an absolute filesystem path
    expect(heartbeat?.path).not.toMatch(/^\//);
    expect(heartbeat?.path).not.toContain(workspaceDir);
  });

  // TC-243-U-02: All canonical db: namespace variants pass through unchanged
  it.each([
    ["db:UNIVERSAL/USER.md", "USER_UNIVERSAL.md"],
    ["db:GLOBAL/COMMUNICATION.md", "COMMUNICATION.md"],
    ["db:DOMAIN:Quality Assurance/AB_TESTING_METHODOLOGY.md", "AB_TESTING_METHODOLOGY.md"],
    ["db:WORKFLOW:Daily Inspiration Art/WORKFLOW.md", "WORKFLOW_SYNTH.md"],
    ["db:agent/SOUL.md", "SOUL_AGENT.md"], // lowercase db prefix still qualifies
  ])("TC-243-U-02: preserves synthetic path %s unchanged", async (syntheticPath, uniqueName) => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: uniqueName,
          path: syntheticPath,
          content: "content",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    // Find by the synthetic path directly (avoids name collision with workspace files)
    const file = files.find((f) => f.path === syntheticPath);

    expect(file).toBeDefined();
    expect(file?.path).toBe(syntheticPath);
    // Must NOT be resolved to an absolute filesystem path
    expect(file?.path).not.toMatch(/^\//);
  });

  // TC-243-U-03: fallback: namespace path passes through unchanged
  it("TC-243-U-03: preserves fallback: namespace path unchanged", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "UNIVERSAL_SEED.md",
          path: "fallback:UNIVERSAL_SEED.md",
          content: "seed",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const file = files.find((f) => f.path === "fallback:UNIVERSAL_SEED.md");

    expect(file?.path).toBe("fallback:UNIVERSAL_SEED.md");
  });

  // TC-243-U-04: emergency: namespace path passes through unchanged
  it("TC-243-U-04: preserves emergency: namespace path unchanged", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "RECOVERY.md",
          path: "emergency:RECOVERY.md",
          content: "recovery",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const file = files.find((f) => f.path === "emergency:RECOVERY.md");

    expect(file?.path).toBe("emergency:RECOVERY.md");
  });

  // TC-243-U-05: Normal workspace-relative path still resolved (no regression)
  it("TC-243-U-05: still resolves workspace-relative path AGENTS.md normally", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agents = files.find((f) => f.name === "AGENTS.md");

    expect(agents?.path).toBe(path.join(workspaceDir, "AGENTS.md"));
    // Must be an absolute path
    expect(path.isAbsolute(agents?.path ?? "")).toBe(true);
  });

  // TC-243-U-06: Absolute filesystem path still resolved normally (no regression)
  it("TC-243-U-06: still handles absolute path /tmp/something.md normally", async () => {
    const absolutePath = "/tmp/openclaw-test-bootstrap-file.md";
    await fs.writeFile(absolutePath, "absolute content", "utf8");

    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "something.md",
          path: absolutePath,
          content: "absolute content",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const file = files.find((f) => f.name === "something.md");

    expect(file?.path).toBe(absolutePath); // resolved absolute remains absolute
    await fs.unlink(absolutePath).catch(() => {});
  });

  // TC-243-DEDUP-01: Two identical synthetic paths → one entry survives
  it("TC-243-DEDUP-01: deduplicates identical synthetic paths", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "HEARTBEAT_DB.md",
          path: "db:AGENT/HEARTBEAT.md",
          content: "first",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
        {
          name: "HEARTBEAT_DB.md",
          path: "db:AGENT/HEARTBEAT.md",
          content: "second",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const heartbeats = files.filter((f) => f.path === "db:AGENT/HEARTBEAT.md");

    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.content).toBe("first"); // first-seen wins
  });

  // TC-243-DEDUP-02: Synthetic path and workspace-relative with same-looking filename
  // are NOT collapsed — they have different dedupe keys.
  it("TC-243-DEDUP-02: does not collapse synthetic path and workspace-relative path with same filename", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "HEARTBEAT.md",
          path: "db:AGENT/HEARTBEAT.md",
          content: "db content",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
        {
          name: "HEARTBEAT.md",
          path: path.join(ctx.workspaceDir, "HEARTBEAT.md"),
          content: "fs content",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "fs content", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    // The workspace HEARTBEAT.md and the synthetic HEARTBEAT.md must both survive;
    // the hook's filesystem HEARTBEAT.md is a duplicate of the workspace one and gets dropped.
    const syntheticEntry = files.find((f) => f.path === "db:AGENT/HEARTBEAT.md");
    const fsEntry = files.find((f) => f.path === path.join(workspaceDir, "HEARTBEAT.md"));

    expect(syntheticEntry).toBeDefined();
    expect(fsEntry).toBeDefined();
  });

  // TC-243-DEDUP-03: Two different synthetic paths with same-looking suffix remain distinct
  it("TC-243-DEDUP-03: does not collapse distinct synthetic namespaces with same filename", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "CONFIG.md",
          path: "db:UNIVERSAL/CONFIG.md",
          content: "universal",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
        {
          name: "CONFIG.md",
          path: "db:agent/CONFIG.md",
          content: "agent",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const universalEntry = files.find((f) => f.path === "db:UNIVERSAL/CONFIG.md");
    const agentEntry = files.find((f) => f.path === "db:agent/CONFIG.md");

    expect(universalEntry).toBeDefined();
    expect(agentEntry).toBeDefined();
  });

  // TC-243-NEG-01: Non-synthetic colon-containing paths go through normal resolution
  it.each([[":leading-colon.md"], ["1db:something.md"], ["foo/db:bar.md"]])(
    "TC-243-NEG-01: non-synthetic path %s goes through normal (filesystem) resolution",
    async (nonSyntheticPath) => {
      registerInternalHook("agent:bootstrap", (event) => {
        const ctx = event.context as AgentBootstrapHookContext;
        ctx.bootstrapFiles = [
          ...ctx.bootstrapFiles,
          {
            name: "weird.md",
            path: nonSyntheticPath,
            content: "content",
            missing: false,
          } as unknown as WorkspaceBootstrapFile,
        ];
      });

      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
      const files = await resolveBootstrapFilesForRun({ workspaceDir });
      const file = files.find((f) => f.name === "weird.md");

      if (file) {
        // Path must have been resolved to an absolute filesystem path, not the raw input
        expect(path.isAbsolute(file.path)).toBe(true);
        expect(file.path).not.toBe(nonSyntheticPath);
      }
      // If the file is absent (sanitizer dropped it), that's also acceptable —
      // the key point is it did NOT pass through as an opaque synthetic identifier.
    },
  );

  // TC-243-U-EXTRA-01: Warning NOT emitted for valid synthetic paths
  it("TC-243-U-EXTRA-01: does not emit a warning for valid synthetic paths", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "HEARTBEAT_DB.md",
          path: "db:AGENT/HEARTBEAT.md",
          content: "hb",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.filter((w) => w.includes("db:AGENT"))).toHaveLength(0);
  });

  // TC-243-CROSS-01 proxy test: synthetic path returned before any path.resolve is attempted
  it("TC-243-CROSS-01: synthetic path is returned before any path.resolve is attempted", async () => {
    const syntheticPath = "db:AGENT/HEARTBEAT.md";

    registerInternalHook("agent:bootstrap", (event) => {
      const ctx = event.context as AgentBootstrapHookContext;
      ctx.bootstrapFiles = [
        ...ctx.bootstrapFiles,
        {
          name: "HEARTBEAT_DB.md",
          path: syntheticPath,
          content: "hb",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const file = files.find((f) => f.path === syntheticPath);

    // If path.resolve had been called, the result would be an absolute path.
    // If synthetic bypass works, the path is exactly the input string.
    expect(file?.path).toBe(syntheticPath);
    expect(file?.path?.startsWith("/")).toBe(false); // Not an absolute POSIX path
    expect(file?.path?.match(/^[A-Za-z]:\\/)).toBeNull(); // Not a Windows drive path
  });
});
