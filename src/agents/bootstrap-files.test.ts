import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { clearAllBootstrapSnapshots } from "./bootstrap-cache.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
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
  beforeEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });
  afterEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });

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

  it("uses channel/account-specific SOUL when sessionKey is present", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "default soul", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.test2.md"), "test2 soul", "utf8");

    const defaultFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "telegram:default:anything",
    });
    const test2Files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "telegram:test2:anything",
    });

    const defaultSoul = defaultFiles.find((file) => file.name === "SOUL.md");
    const test2Soul = test2Files.find((file) => file.name === "SOUL.md");

    expect(path.basename(defaultSoul?.path ?? "")).toBe("SOUL.md");
    expect(path.basename(test2Soul?.path ?? "")).toBe("SOUL.test2.md");
    expect(defaultSoul?.content).toBe("default soul");
    expect(test2Soul?.content).toBe("test2 soul");
  });

  it("prefers explicit channel/account over collapsed agent session keys", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "default soul", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.test2.md"), "test2 soul", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:main",
      channel: "telegram",
      accountId: "test2",
      config: {
        channels: {
          telegram: {
            accounts: {
              default: { token: "x" },
              test2: { token: "y", soulFile: "SOUL.test2.md" },
            },
          },
        },
      } as never,
    });

    const soul = files.find((file) => file.name === "SOUL.md");
    expect(path.basename(soul?.path ?? "")).toBe("SOUL.test2.md");
    expect(soul?.content).toBe("test2 soul");
  });

  it("parses routed agent session keys for channel/account-specific SOUL", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "default soul", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.test2.md"), "test2 soul", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:telegram:test2:direct:123456789",
      config: {
        channels: {
          telegram: {
            accounts: {
              test2: { token: "x", soulFile: "SOUL.test2.md" },
            },
          },
        },
      } as never,
    });

    const soul = files.find((file) => file.name === "SOUL.md");
    expect(path.basename(soul?.path ?? "")).toBe("SOUL.test2.md");
    expect(soul?.content).toBe("test2 soul");
  });

  it("uses top-level channel soulFile when account map is absent", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "default soul", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.slack.md"), "slack soul", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:C123",
      config: {
        channels: {
          slack: {
            soulFile: "SOUL.slack.md",
          },
        },
      } as never,
    });

    const soul = files.find((file) => file.name === "SOUL.md");
    expect(path.basename(soul?.path ?? "")).toBe("SOUL.slack.md");
    expect(soul?.content).toBe("slack soul");
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
});
