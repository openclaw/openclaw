import { describe, expect, it, vi } from "vitest";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { buildEmbeddedAgentHookContext } from "../embedded-agent-runner/run/agent-hook-context.js";
import { buildAgentHookContext } from "./hook-context.js";

// These runs have no memory audience; persistence is unrelated to cron context.
vi.mock("../../plugins/memory-audience.js", () => ({
  assertMemoryAudienceCurrent: vi.fn(),
  assertMemoryAudienceSession: vi.fn(),
}));

const run = {
  runId: "cron-prompt-run",
  sessionId: "cron-session",
  sessionKey: "agent:main:cron:daily-check",
  workspaceDir: "/workspace",
  trigger: "cron" as const,
};

describe.each([
  ["embedded", () => buildEmbeddedAgentHookContext(run, "main", undefined)],
  ["plugin harness and CLI lifecycle", () => buildAgentHookContext({ ...run, agentId: "main" })],
] as const)("%s cron hook context", (_name, buildContext) => {
  it("carries the executor's immutable revision through the actual prompt context builder", () => {
    const unregister = registerCronRunExecSource(run.runId, {
      agentId: "main",
      jobId: "daily-check",
      jobConfigRevision: "snapshot-revision",
      jobName: "Daily check",
    });
    try {
      const context = buildContext();
      expect(context).toMatchObject({
        runId: run.runId,
        jobId: "daily-check",
        jobConfigRevision: "snapshot-revision",
      });
      unregister();
      expect(buildContext()).not.toHaveProperty("jobConfigRevision");
    } finally {
      unregister();
    }
  });
});
