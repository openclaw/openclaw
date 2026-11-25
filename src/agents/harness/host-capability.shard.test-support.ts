import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

export function admissionFixture(
  defaults: Partial<HostAttempt> = {},
  boundary = "host-capability-test",
) {
  const admissions: PreparedAgentRunAdmission[] = [];
  return {
    admittedAttempt: async (
      runId = "run-1",
      overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
    ) => {
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: { runId, agentId: "main", ingress: { kind: "system", boundary, state: "present" } },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      admissions.push(admission);
      const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
      const attempt: HostAttempt = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId,
        ...defaults,
        ...overrides,
        admittedRunContext,
      };
      return { admission, attempt };
    },
    closeAdmissions: () => {
      for (const admission of admissions.splice(0)) {
        admission.close();
      }
    },
  };
}

export const workspaceDefaults: Partial<HostAttempt> = {
  cwd: "/attempt/worktree",
  workspaceDir: "/workspace",
  currentChannelId: "chat-1",
  messageChannel: "telegram",
};

export function testTool(execute = vi.fn(async () => ({ content: [], details: {} }))) {
  const tool: AnyAgentTool = {
    name: "read",
    label: "Read",
    description: "read",
    parameters: Type.Object({}),
    execute,
  };
  return { tool, execute };
}

export function bindTool(attempt: HostAttempt, tool: AnyAgentTool) {
  const host = createAgentHarnessHostCapabilities({ attempt, pluginId: "codex" });
  const bound = expectDefined(host.capabilities.bindToolSurface([tool])[0], "bound tool");
  return { host, bound };
}
