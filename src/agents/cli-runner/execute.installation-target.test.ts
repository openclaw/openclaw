import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getInstallationTarget,
  withInstallationTarget,
} from "../../infra/installation-target-context.js";
import type { CliBackendResolveExecutionArgsContext } from "../../plugins/cli-backend.types.js";
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
const scratchEnv = {
  OPENCLAW_STATE_DIR: "/fixture/scratch",
  OPENCLAW_CONFIG_PATH: undefined,
  OPENCLAW_WORKSPACE_DIR: "/fixture/execution-cwd",
};
const childEnv = () => supervisorSpawnMock.mock.calls.at(-1)?.[0].env;
const selectEnv = (env: NodeJS.ProcessEnv | undefined) =>
  Object.fromEntries(Object.keys(scratchEnv).map((key) => [key, env?.[key]]));

beforeEach(() => {
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({ ...createSuccessfulProcessExit(), durationMs: 1, stdout: "done" }),
  );
});

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

it.each(["process", "node"] as const)(
  "projects local child environment and fences %s placement",
  async (kind) => {
    const target = { stateDir: "/state", configPath: "/config", defaultWorkspaceDir: "/work" };
    const context = buildPreparedCliRunContext({
      backend: {
        command: "/bin/sh",
        args: [],
        output: "text",
        systemPromptFileArg: undefined,
        input: "stdin",
      },
    });
    if (kind === "node") {
      context.executionTarget = { kind, placement: { nodeId: "fixture-node" } };
    }
    await withEnvAsync(scratchEnv, async () => {
      const run = withInstallationTarget(target, () => executePreparedCliRun(context));
      expect(getInstallationTarget()).toBeUndefined();
      if (kind === "node") {
        await expect(run).rejects.toThrow("saved prompt");
        expect(supervisorSpawnMock).not.toHaveBeenCalled();
        return;
      }
      await expect(run).resolves.toMatchObject({ text: "done" });
      expect(selectEnv(childEnv())).toEqual({
        OPENCLAW_STATE_DIR: target.stateDir,
        OPENCLAW_CONFIG_PATH: target.configPath,
        OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
      });
      expect(selectEnv(process.env)).toEqual(scratchEnv);
      await executePreparedCliRun(context);
      expect(selectEnv(childEnv())).toEqual(scratchEnv);
    });
  },
);

it("counts awaited backend setup against the automatic cutoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
    ...context.baseArgs,
  ]);
  const context = buildPreparedCliRunContext({
    provider: "codex-cli",
    fastMode: "auto",
    resolveExecutionArgs,
    backend: { command: "/bin/sh", args: ["exec"], output: "text", input: "stdin" },
  });
  context.params.fastModeAutoOnSeconds = 1;
  context.preparedBackend.beforeExecution = async () => {
    vi.setSystemTime(2001);
  };
  await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
  expect(resolveExecutionArgs.mock.calls[0]?.[0].fastMode).toBe(false);
});
