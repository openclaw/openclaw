import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

async function realWorkspace(workspaceDir: string): Promise<string> {
  try {
    return await fs.promises.realpath(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

afterEach(() => supervisorSpawnMock.mockReset());

async function runWithChildConfigDir(params: {
  hostConfigDir?: string;
  childConfigDir?: string;
  workspaceDir: string;
  recoverHistory?: boolean;
}) {
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    workspaceDir: params.workspaceDir,
    ...(params.childConfigDir === undefined
      ? {}
      : { preparedEnv: { CLAUDE_CONFIG_DIR: params.childConfigDir } }),
  });
  if (params.recoverHistory) {
    context.openClawHistoryPrompt = "recovered history";
    context.cliHistoryWriter = {
      target: {
        agentId: "main",
        sessionId: context.params.sessionId,
        sessionKey: "agent:main:test",
        storePath: path.join(params.workspaceDir, "sessions.db"),
      },
      runId: context.params.runId,
      authFingerprint: "f".repeat(64),
      assertCurrent: () => {},
      assertReadable: () => {},
    };
  }
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      durationMs: 1,
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    }),
  );
  await withEnvAsync({ CLAUDE_CONFIG_DIR: params.hostConfigDir }, async () => {
    await executePreparedCliRun(context);
  });
  const spawnRequest = supervisorSpawnMock.mock.lastCall?.[0] as
    | { env?: NodeJS.ProcessEnv }
    | undefined;
  const spawnEnv = spawnRequest?.env;
  return { childConfigDir: spawnEnv?.CLAUDE_CONFIG_DIR, retained: context.claudeTranscriptRoot };
}

describe("Claude CLI transcript root retention", () => {
  it("retains the child override instead of the Gateway config dir", async () => {
    const hostConfigDir = path.join(os.tmpdir(), "host-claude");
    const childConfigDir = path.join(os.tmpdir(), "child-claude");
    const { childConfigDir: spawned, retained } = await runWithChildConfigDir({
      hostConfigDir,
      childConfigDir,
      workspaceDir: path.join(os.tmpdir(), "workspace"),
    });
    expect(spawned).toBe(childConfigDir);
    expect(retained).toBe(path.join(childConfigDir, "projects"));
  });

  it("resolves a relative child override against the child working directory", async () => {
    const workspaceDir = path.join(os.tmpdir(), "relative-workspace");
    const { retained } = await runWithChildConfigDir({
      hostConfigDir: path.join(os.tmpdir(), "host-claude"),
      childConfigDir: "child profile",
      workspaceDir,
    });
    expect(retained).toBe(
      path.join(await realWorkspace(workspaceDir), "child profile", "projects"),
    );
  });

  it("retains the Gateway config dir when the child does not override it", async () => {
    const hostConfigDir = path.join(os.tmpdir(), "host-claude");
    const { childConfigDir, retained } = await runWithChildConfigDir({
      hostConfigDir,
      workspaceDir: path.join(os.tmpdir(), "workspace"),
    });
    expect(childConfigDir).toBe(hostConfigDir);
    expect(retained).toBe(path.join(hostConfigDir, "projects"));
  });

  it("retains the child override on the caller's context during history recovery", async () => {
    const childConfigDir = path.join(os.tmpdir(), "recovered-child-claude");
    const { retained } = await runWithChildConfigDir({
      hostConfigDir: path.join(os.tmpdir(), "host-claude"),
      childConfigDir,
      workspaceDir: path.join(os.tmpdir(), "workspace"),
      recoverHistory: true,
    });
    expect(retained).toBe(path.join(childConfigDir, "projects"));
  });

  it("retains the native home default when no config dir is selected", async () => {
    const { retained } = await runWithChildConfigDir({
      workspaceDir: path.join(os.tmpdir(), "workspace"),
    });
    expect(retained).toBe(path.join(process.env.HOME ?? os.homedir(), ".claude", "projects"));
  });
});
