import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { runCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";

const { prepareCliRunContext, executePreparedCliRun } = vi.hoisted(() => ({
  prepareCliRunContext: vi.fn<(params: RunCliAgentParams) => Promise<PreparedCliRunContext>>(),
  executePreparedCliRun: vi.fn<(context: PreparedCliRunContext) => Promise<CliOutput>>(),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext }));
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));

describe("CLI operator model execution", () => {
  it.each([false, true])(
    "fences cron root replacement during CLI preparation (replace=%s)",
    async (replace) => {
      prepareCliRunContext.mockReset();
      executePreparedCliRun.mockReset();
      await withOpenClawTestState({ label: "cli-cron-root-fence" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId: "cron-run-1",
          sessionKey: "agent:main:cron:cli-fence",
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        };
        const entry = {
          sessionId: target.sessionId,
          lifecycleRevision: "generation-1",
          updatedAt: 1,
        };
        replaceSessionEntrySync(target, entry);
        const context = buildPreparedCliRunContext({
          provider: "google-gemini-cli",
          model: "transport-alias",
          backend: { sessionMode: "none" },
          runId: "cli-cron-root",
        });
        const admission = prepareSystemAgentRunAdmission(
          {},
          context.params.runId,
          "main",
          "cli-cron-root-test",
        );
        const processStart = vi.fn(() => ({ text: "current root reply" }));
        prepareCliRunContext.mockImplementation(async (params) => {
          if (!params.admittedRunContext) {
            throw new Error("Expected admitted CLI run");
          }
          if (replace) {
            replaceSessionEntrySync(target, {
              ...entry,
              sessionId: "cron-run-2",
              lifecycleRevision: "generation-2",
            });
          }
          return {
            ...context,
            params: { ...params, admittedRunContext: params.admittedRunContext },
          };
        });
        executePreparedCliRun.mockImplementation(async (prepared) => {
          prepared.params.assertCurrent?.();
          return processStart();
        });
        try {
          const operation = runCliAgent({
            ...context.params,
            ...target,
            sessionFile: target.sessionKey,
            sessionTarget: target,
            sessionEntry: entry,
            admittedRunContext: await admission.admit("embedded"),
          });
          if (replace) {
            await expect(operation).rejects.toThrow(
              "original session generation no longer accepts",
            );
            expect(processStart).not.toHaveBeenCalled();
          } else {
            expect((await operation).payloads).toEqual([{ text: "current root reply" }]);
            expect(processStart).toHaveBeenCalledOnce();
          }
        } finally {
          admission.close();
        }
      });
    },
  );
});
