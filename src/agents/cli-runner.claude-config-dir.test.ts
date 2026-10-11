/** Tests that a forked Claude attempt still settles under the child's own transcript root. */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runPreparedCliAgent as runPreparedCliAgentCore } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { createManagedRun, supervisorSpawnMock } from "./cli-runner.test-support.js";
import {
  createSuccessfulProcessExit,
  wrapPreparedCliRunWithTestAdmission,
} from "./cli-runner/execute.test-support.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "./cli-session.js";
import * as cliTranscript from "./command/attempt-execution.helpers.js";

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentCore);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("Claude CLI transcript root across a forked attempt", () => {
  it("probes and persists the child's root when the attempt runs on a forked context", async () => {
    const workspaceDir = path.join(os.tmpdir(), "openclaw-fork-workspace");
    const hostConfigDir = path.join(os.tmpdir(), "openclaw-gateway-claude");
    const childConfigDir = path.join(os.tmpdir(), "openclaw-child-claude");
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      workspaceDir,
      sessionKey: "agent:main:fork-root",
      preparedEnv: { CLAUDE_CONFIG_DIR: childConfigDir },
    });
    context.reusableCliSession = { mode: "reuse", sessionId: "resumed-session" };
    context.params.forkCliSessionOnResume = true;
    context.params.persistCliSessionForkSuccessor = vi.fn(async () => {});
    const transcriptProbe = vi
      .spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent")
      .mockResolvedValue(true);
    supervisorSpawnMock.mockResolvedValue(
      createManagedRun({
        ...createSuccessfulProcessExit(),
        durationMs: 1,
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "done",
          session_id: "forked-session",
        }),
      }),
    );

    const result = await withEnvAsync(
      { CLAUDE_CONFIG_DIR: hostConfigDir },
      async () => await runPreparedCliAgent(context),
    );

    const childProjectsRoot = path.join(childConfigDir, "projects");
    expect(transcriptProbe).toHaveBeenCalledWith(
      expect.objectContaining({ projectsRoot: childProjectsRoot }),
    );
    const entry: SessionEntry = { sessionId: context.params.sessionId, updatedAt: 1 };
    applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);
    expect(getCliSessionBinding(entry, "claude-cli")?.transcriptRoot).toBe(childProjectsRoot);
  });
});
