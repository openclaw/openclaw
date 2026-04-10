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
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveBootstrapSignatureForRun,
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

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("selects a model-specific AGENTS file for main runs", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.gpt-5.4.md"), "gpt rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFilesByModel: {
              "openai/gpt-5.4": "AGENTS.gpt-5.4.md",
            },
          },
          list: [{ id: "main" }],
        },
      },
      sessionKey: "agent:main:main",
      modelProviderId: "openai",
      modelId: "gpt-5.4",
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.gpt-5.4.md"));
    expect(agentsFile?.content).toBe("gpt rules");
  });

  it("selects a subagent-specific AGENTS file and allows model overrides", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SUBAGENTS.md"), "subagent rules", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "SUBAGENTS.gpt-5.4.md"),
      "gpt subagent rules",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            subagents: {
              agentsFile: "SUBAGENTS.md",
              agentsFilesByModel: {
                "openai/gpt-5.4": "SUBAGENTS.gpt-5.4.md",
              },
            },
          },
          list: [{ id: "main" }],
        },
      },
      sessionKey: "agent:main:subagent:task-1",
      modelProviderId: "openai",
      modelId: "gpt-5.4",
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "SUBAGENTS.gpt-5.4.md"));
    expect(agentsFile?.content).toBe("gpt subagent rules");
  });

  it("prefers per-agent main AGENTS overrides over defaults", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.coder.md"), "coder rules", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.coder.gpt-5.4.md"),
      "coder gpt rules",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "AGENTS.md",
          },
          list: [
            {
              id: "coder",
              agentsFile: "AGENTS.coder.md",
              agentsFilesByModel: {
                "openai/gpt-5.4": "AGENTS.coder.gpt-5.4.md",
              },
            },
          ],
        },
      },
      sessionKey: "agent:coder:main",
      modelProviderId: "openai",
      modelId: "gpt-5.4",
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.coder.gpt-5.4.md"));
    expect(agentsFile?.content).toBe("coder gpt rules");
  });

  it("falls back to AGENTS.md when a configured override escapes the workspace", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "../outside.md",
          },
          list: [{ id: "main" }],
        },
      },
      warn: (message) => warnings.push(message),
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.md"));
    expect(agentsFile?.content).toBe("default rules");
    expect(warnings[0]).toContain("must stay within the workspace root");
  });

  it("uses the per-agent config label in override warnings", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    const warnings: string[] = [];

    await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          list: [
            {
              id: "coder",
              agentsFile: "../outside.md",
            },
          ],
        },
      },
      sessionKey: "agent:coder:main",
      warn: (message) => warnings.push(message),
    });

    expect(warnings[0]).toContain("agents.list.coder.agentsFile");
  });

  it("accepts dot-dot-prefixed AGENTS filenames that stay inside the workspace", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "..agents.md"), "prefixed rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "..agents.md",
          },
          list: [{ id: "main" }],
        },
      },
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "..agents.md"));
    expect(agentsFile?.content).toBe("prefixed rules");
  });

  it("falls back to the default base override when a per-agent base override cannot be loaded", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.shared.md"), "shared rules", "utf8");
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "AGENTS.shared.md",
          },
          list: [
            {
              id: "coder",
              agentsFile: "AGENTS.missing.md",
            },
          ],
        },
      },
      sessionKey: "agent:coder:main",
      warn: (message) => warnings.push(message),
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.shared.md"));
    expect(warnings[0]).toContain("agents.list.coder.agentsFile");
  });

  it("deduplicates same-path fallback warnings across config labels", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "AGENTS.missing.md",
          },
          list: [
            {
              id: "coder",
              agentsFile: "AGENTS.missing.md",
            },
          ],
        },
      },
      sessionKey: "agent:coder:main",
      warn: (message) => warnings.push(message),
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.md"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AGENTS.missing.md");
  });

  it("falls back to the default model override when a per-agent model override cannot be loaded", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.shared.gpt-5.4.md"),
      "shared gpt rules",
      "utf8",
    );
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFilesByModel: {
              "openai/gpt-5.4": "AGENTS.shared.gpt-5.4.md",
            },
          },
          list: [
            {
              id: "coder",
              agentsFilesByModel: {
                "openai/gpt-5.4": "AGENTS.missing.gpt-5.4.md",
              },
            },
          ],
        },
      },
      sessionKey: "agent:coder:main",
      modelProviderId: "openai",
      modelId: "gpt-5.4",
      warn: (message) => warnings.push(message),
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.shared.gpt-5.4.md"));
    expect(warnings[0]).toContain('agents.list.coder.agentsFilesByModel["openai/gpt-5.4"]');
  });

  it("preserves unavailable reasons in fallback warnings", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.mkdir(path.join(workspaceDir, "AGENTS.blocked.md"));
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            agentsFile: "AGENTS.blocked.md",
          },
          list: [{ id: "main" }],
        },
      },
      warn: (message) => warnings.push(message),
    });

    const agentsFile = files.find((file) => file.name === "AGENTS.md");
    expect(agentsFile?.path).toBe(path.join(workspaceDir, "AGENTS.md"));
    expect(warnings[0]).toContain("could not be loaded");
    expect(warnings[0]).toContain("workspace validation");
  });

  it("passes resolved model identity into bootstrap hooks", async () => {
    const seenContexts: Array<Pick<AgentBootstrapHookContext, "modelProviderId" | "modelId">> = [];
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      seenContexts.push({
        modelProviderId: context.modelProviderId,
        modelId: context.modelId,
      });
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await resolveBootstrapFilesForRun({
      workspaceDir,
      modelProviderId: "openai",
      modelId: "gpt-5.4",
    });

    expect(seenContexts).toEqual([{ modelProviderId: "openai", modelId: "gpt-5.4" }]);
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

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toEqual([]);
  });

  it("skips AGENTS override resolution when lightweight filtering removes AGENTS.md", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
      config: {
        agents: {
          defaults: {
            agentsFile: "../outside.md",
          },
          list: [{ id: "main" }],
        },
      },
      warn: (message) => warnings.push(message),
    });

    expect(files).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

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

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat cadence is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

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

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
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

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("records workspace-relative bootstrap signatures from hook-adjusted AGENTS paths", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = context.bootstrapFiles.map((file) =>
        file.name === "AGENTS.md"
          ? {
              ...file,
              path: path.join(context.workspaceDir, "AGENTS.hook.md"),
              content: "hook rules",
              missing: false,
            }
          : file,
      );
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.hook.md"), "hook rules", "utf8");

    const result = await resolveBootstrapContextForRun({ workspaceDir });

    expect(result.bootstrapSignature).toBe("agents:AGENTS.hook.md");
  });

  it("does not invoke bootstrap hooks for signature-only resolution", async () => {
    let hookCalls = 0;
    registerInternalHook("agent:bootstrap", () => {
      hookCalls += 1;
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "default rules", "utf8");

    const signature = await resolveBootstrapSignatureForRun({ workspaceDir });

    const expectedPath = path.join(workspaceDir, "AGENTS.md").replace(/\\/g, "/");
    expect(signature).toBe(`agents:${expectedPath}`);
    expect(hookCalls).toBe(0);
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

  it("returns false when the bootstrap signature changed", async () => {
    const sessionFile = path.join(tmpDir, "signature-mismatch.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1, bootstrapSignature: "agents:/tmp/AGENTS.old.md" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile, "agents:/tmp/AGENTS.new.md")).toBe(false);
  });

  it("returns false when a signature is expected but the recorded marker has none", async () => {
    const sessionFile = path.join(tmpDir, "signature-missing.jsonl");
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

    expect(await hasCompletedBootstrapTurn(sessionFile, "agents:/tmp/AGENTS.new.md")).toBe(false);
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
});
