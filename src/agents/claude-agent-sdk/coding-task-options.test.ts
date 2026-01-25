import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { buildCodingTaskSdkOptions } from "./coding-task-options.js";

describe("buildCodingTaskSdkOptions", () => {
  it("defaults to readonly + default permissionMode", async () => {
    const resolved = buildCodingTaskSdkOptions({ cwd: "/repo" });

    expect(resolved.permissionMode).toBe("default");
    expect(resolved.toolPreset).toBe("readonly");
    expect(resolved.allowedTools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    expect(resolved.disallowedTools).toEqual(
      expect.arrayContaining(["AskUserQuestion", "ExitPlanMode"]),
    );

    const canUseTool = resolved.options.canUseTool as unknown as (
      toolName: string,
      input: unknown,
    ) => Promise<Record<string, unknown>>;

    const allow = await canUseTool("Read", { filePath: "src/index.ts" });
    expect(allow).toMatchObject({ behavior: "allow" });

    const deny = await canUseTool("Bash", { command: "echo hi" });
    expect(deny).toMatchObject({ behavior: "deny" });
  });

  it("canonicalizes tool rules and supports wildcard allow with explicit deny", async () => {
    const cfg: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          toolPreset: "readonly",
          allowedTools: ["*", "read(~/.ssh/*)", "Bash(git*)"],
          disallowedTools: ["bash"],
        },
      },
    };

    const resolved = buildCodingTaskSdkOptions({ config: cfg, cwd: "/repo" });

    expect(resolved.allowedTools).toEqual(
      expect.arrayContaining(["*", "Read(~/.ssh/*)", "Bash(git*)"]),
    );
    expect(resolved.disallowedTools).toEqual(expect.arrayContaining(["Bash"]));

    const canUseTool = resolved.options.canUseTool as unknown as (
      toolName: string,
      input: unknown,
    ) => Promise<Record<string, unknown>>;

    const allow = await canUseTool("Grep", { pattern: "TODO" });
    expect(allow).toMatchObject({ behavior: "allow" });

    const deny = await canUseTool("Bash", { command: "git status" });
    expect(deny).toMatchObject({ behavior: "deny" });
  });

  it("allows tools when allowedTools contains a rule pattern for that tool", async () => {
    const cfg: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          toolPreset: "readonly",
          allowedTools: ["Bash(git*)"],
        },
      },
    };

    const resolved = buildCodingTaskSdkOptions({ config: cfg, cwd: "/repo" });
    const canUseTool = resolved.options.canUseTool as unknown as (
      toolName: string,
      input: unknown,
    ) => Promise<Record<string, unknown>>;

    const allow = await canUseTool("Bash", { command: "git status" });
    expect(allow).toMatchObject({ behavior: "allow" });
  });

  it("sets systemPrompt preset for claude_code toolPreset", () => {
    const cfg: ClawdbotConfig = {
      tools: {
        codingTask: {
          enabled: true,
          toolPreset: "claude_code",
        },
      },
    };

    const resolved = buildCodingTaskSdkOptions({ config: cfg, cwd: "/repo" });
    expect(resolved.options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
    });
  });
});
