import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

describe("CLI installation target", () => {
  it.each(["process", "node"] as const)(
    "projects local child environment and fences %s placement",
    async (kind) => {
      const target = {
        stateDir: "/fixture/diagnosed",
        configPath: "/fixture/custom.json",
        defaultWorkspaceDir: "/fixture/default-workspace",
      };
      const context = buildPreparedCliRunContext({
        model: "fixture-model",
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
      supervisorSpawnMock.mockResolvedValue(
        createManagedRun({
          ...createSuccessfulProcessExit(),
          durationMs: 1,
          stdout: "done",
        }),
      );
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: "/fixture/scratch",
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_WORKSPACE_DIR: "/fixture/execution-cwd",
        },
        async () => {
          const run = withInstallationTarget(target, () => executePreparedCliRun(context));
          expect(getInstallationTarget()).toBeUndefined();
          if (kind === "node") {
            await expect(run).rejects.toThrow("saved prompt");
            expect(supervisorSpawnMock).not.toHaveBeenCalled();
            return;
          }
          await expect(run).resolves.toMatchObject({ text: "done" });
          const expectedEnv = {
            OPENCLAW_STATE_DIR: target.stateDir,
            OPENCLAW_CONFIG_PATH: target.configPath,
            OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
          };
          expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ env: expect.objectContaining(expectedEnv) }),
          );
          expect(process.env.OPENCLAW_STATE_DIR).toBe("/fixture/scratch");
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/fixture/execution-cwd");
          await executePreparedCliRun(context);
          expect(supervisorSpawnMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
              env: expect.objectContaining({
                OPENCLAW_STATE_DIR: "/fixture/scratch",
                OPENCLAW_WORKSPACE_DIR: "/fixture/execution-cwd",
              }),
            }),
          );
          expect(supervisorSpawnMock).not.toHaveBeenLastCalledWith(
            expect.objectContaining({
              env: expect.objectContaining({ OPENCLAW_CONFIG_PATH: expect.anything() }),
            }),
          );
        },
      );
    },
  );
});

it("resolves ultrafast mode to enabled at execution", async () => {
  const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
    ...context.baseArgs,
  ]);
  const context = buildPreparedCliRunContext({
    provider: "codex-cli",
    model: "fixture-model",
    thinkLevel: "high",
    fastMode: "ultrafast",
    resolveExecutionArgs,
    backend: {
      command: "/bin/sh",
      args: ["exec", "--json"],
      output: "text",
      systemPromptFileArg: undefined,
      input: "stdin",
    },
  });
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      durationMs: 1,
      stdout: "done",
    }),
  );

  await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });

  expect(resolveExecutionArgs).toHaveBeenCalledTimes(1);
  const resolved = resolveExecutionArgs.mock.calls[0]?.[0];
  expect(resolved).toBeDefined();
  expect(resolved?.fastMode).toBe(true);
  expect(resolved?.thinkingLevel).toBe("high");
  expect(resolved?.baseArgs).toEqual(["exec", "--json"]);
});

it("counts awaited backend setup against the automatic cutoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
    ...context.baseArgs,
  ]);
  const context = buildPreparedCliRunContext({
    provider: "codex-cli",
    model: "fixture-model",
    fastMode: "auto",
    resolveExecutionArgs,
    backend: { command: "/bin/sh", args: ["exec"], output: "text", input: "stdin" },
  });
  context.params.fastModeAutoOnSeconds = 1;
  context.preparedBackend.beforeExecution = async () => {
    vi.setSystemTime(2001);
  };
  supervisorSpawnMock.mockResolvedValue(
    createManagedRun({
      ...createSuccessfulProcessExit(),
      stdout: "done",
    }),
  );

  await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
  expect(resolveExecutionArgs.mock.calls[0]?.[0].fastMode).toBe(false);
});
