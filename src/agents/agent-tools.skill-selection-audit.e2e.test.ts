/**
 * Skill-selection audit coverage for wrapped tool reads of known skill files.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentAuditEvent } from "../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function asAgentTool(tool: { name: string; execute: ReturnType<typeof vi.fn> }): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

describe("before_tool_call skill selection audit", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    const hookRunner = {
      ...createHookRunner(createEmptyPluginRegistry()),
      hasHooks: vi.fn<HookRunner["hasHooks"]>().mockReturnValue(false),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
  });

  afterEach(() => {
    mockGetGlobalHookRunner.mockReset();
  });

  async function withSkillUsageDiagnosticEvents(
    run: (
      emitted: DiagnosticEventPayload[],
      privateData: DiagnosticEventPrivateData[],
      flush: () => Promise<void>,
    ) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const skillUsagePrivateData: DiagnosticEventPrivateData[] = [];
    const stopShared = onInternalDiagnosticEvent((event) => emitted.push(event));
    const stopTrusted = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "skill.used") {
        skillUsagePrivateData.push(privateData);
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, skillUsagePrivateData, flush);
    } finally {
      stopTrusted();
      stopShared();
    }
  }

  it("emits skill_selection audit when a run reads a known skill instruction file", async () => {
    const workspaceDir = path.join("/tmp", "openclaw-skill-usage");
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "demo-skill",
            description: "Demo",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    const auditEvents: unknown[] = [];
    const stopAudit = onAgentAuditEvent((event) => auditEvents.push(event));
    await withSkillUsageDiagnosticEvents(async (_emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-skill-read",
        { path: `${path.join(".agents", "skills", "demo-skill", "SKILL.md")}</arg_value>>` },
        undefined,
        undefined,
      );
      await flush();

      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
      expect(auditEvents).toEqual([
        expect.objectContaining({
          runId: "run-1",
          stream: "skill_selection",
          agentId: "main",
          sessionKey: "session-key",
          sessionId: "session-id",
          data: {
            kind: "skill_selection",
            schemaVersion: 1,
            agentId: "main",
            sessionKey: "session-key",
            sessionId: "session-id",
            runId: "run-1",
            selectedSkill: "demo-skill",
            selectionSource: "observed_runtime",
            selectionConfidence: "observed",
            selectionRule: "tool_invocation",
            activation: "read",
            skillSource: "workspace",
            redaction: "metadata_only",
          },
        }),
      ]);
      expect(consumeRunSkillUsage("run-1")).toEqual([
        {
          name: "demo-skill",
          source: "workspace",
          activation: "read",
          skillFile: skillFilePath,
        },
      ]);
      expect(consumeRunSkillUsage("run-1")).toEqual([]);
    });
    stopAudit();
  });
});
