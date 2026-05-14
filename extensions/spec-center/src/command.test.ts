import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { createSpecCommand } from "./command.js";

async function makeMarkdownSpec() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-center-state-"));
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-center-repo-"));
  const specDir = path.join(repoDir, "specs", "daily");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "overview.md"),
    "# Daily Validation\n\nRuns checks.",
    "utf8",
  );
  await fs.writeFile(
    path.join(specDir, "requirements.md"),
    "# Requirements\n\nAll lanes are recorded.",
    "utf8",
  );
  await fs.writeFile(path.join(specDir, "design.md"), "# Design\n\nNative runtime.", "utf8");
  await fs.writeFile(
    path.join(specDir, "tasks.md"),
    [
      "# Tasks",
      "",
      "| id | type | title | dependsOn | outputs |",
      "| - | - | - | - | - |",
      "| validate_api | tool_task | Run API validation | - | api_result |",
      "| diagnose_failures | agent_task | Diagnose failures | validate_api | diagnosis_report |",
      "| approve_submit | approval | Approve submission | diagnose_failures | - |",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(specDir, "coverage.md"), "# Coverage\n\nAPI lane.", "utf8");
  await fs.writeFile(path.join(specDir, "runbook.md"), "# Runbook\n\nUse /spec preview.", "utf8");
  return { stateDir, repoDir };
}

function createContext(args: string): PluginCommandContext {
  return {
    channel: "feishu",
    isAuthorizedSender: true,
    args,
    commandBody: `/spec ${args}`,
    config: {},
    sessionKey: "agent:main:spec-test",
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

async function run(command: OpenClawPluginCommandDefinition, args: string): Promise<string> {
  const result = await command.handler(createContext(args));
  if (typeof result.text !== "string") {
    throw new Error("command did not return text");
  }
  return result.text;
}

describe("/spec command", () => {
  it("imports, checks, previews, and stores a run for a local Markdown spec", async () => {
    const { stateDir, repoDir } = await makeMarkdownSpec();
    const createManaged = vi.fn(() => ({ flowId: "flow-spec-1" }));
    const api = createTestPluginApi({
      runtime: {
        state: { resolveStateDir: () => stateDir },
        tasks: {
          managedFlows: {
            bindSession: () =>
              ({
                createManaged,
              }) as never,
          },
        },
      } as unknown as OpenClawPluginApi["runtime"],
    });
    const command = createSpecCommand(api);

    await expect(run(command, "init team=arkclaw owner=plugins-platform")).resolves.toContain(
      "Spec Center initialized.",
    );

    const imported = await run(
      command,
      `import id=arkclaw-plugins-daily-run repo=${repoDir} path=specs/daily targetRepo=openclaw/openclaw`,
    );
    expect(imported).toContain("Spec imported.");
    expect(imported).toContain("- steps: 3");
    expect(imported).toContain("Spec check passed.");

    await expect(run(command, "check arkclaw-plugins-daily-run")).resolves.toBe(
      "Spec check passed.",
    );

    const preview = await run(command, "preview arkclaw-plugins-daily-run");
    expect(preview).toContain("Spec run preview created.");
    expect(preview).toContain("- flowId: flow-spec-1");
    expect(preview).toContain("- Wave 1: validate_api");
    expect(preview).toContain("- Wave 2: diagnose_failures");
    expect(preview).toContain("- Wave 3: approve_submit");
    expect(createManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: "spec-center",
        goal: "Preview Spec Center run for arkclaw-plugins-daily-run",
      }),
    );

    await expect(run(command, "status arkclaw-plugins-daily-run")).resolves.toContain(
      "latest run: spec-run-",
    );

    const scheduled = await run(
      command,
      'schedule arkclaw-plugins-daily-run cron="0 9 * * 1-5" timezone=Asia/Shanghai reportTo=this_chat',
    );
    expect(scheduled).toContain("Spec schedule updated.");
    expect(scheduled).toContain("- status: active");

    const report = await run(command, "report arkclaw-plugins-daily-run today");
    expect(report).toContain("Spec Daily Report: Daily Validation");
    expect(report).toContain("- schedule: 0 9 * * 1-5 Asia/Shanghai (active)");
    expect(report).toContain("- validation lanes: validate_api");

    const optimization = await run(
      command,
      'optimize arkclaw-plugins-daily-run "add fixture validation lane"',
    );
    expect(optimization).toContain("Spec optimization preview created.");
    expect(optimization).toContain("- proposed files: requirements.md, coverage.md, tasks.md");
    const optimizationId = optimization.match(/optimizationId: (opt-\d+)/)?.[1];
    expect(optimizationId).toBeDefined();

    const approved = await run(command, `approve ${optimizationId}`);
    expect(approved).toContain("Spec approval recorded.");
    expect(approved).toContain("- decision: approved");

    await expect(run(command, "pause arkclaw-plugins-daily-run")).resolves.toContain(
      "- status: paused",
    );
    await expect(run(command, "resume arkclaw-plugins-daily-run")).resolves.toContain(
      "- status: active",
    );
  });
});
