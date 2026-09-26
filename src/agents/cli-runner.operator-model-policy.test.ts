import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "./admitted-run-context.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { runCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const { prepareCliRunContext, executePreparedCliRun } = vi.hoisted(() => ({
  prepareCliRunContext: vi.fn<(params: RunCliAgentParams) => Promise<PreparedCliRunContext>>(),
  executePreparedCliRun: vi.fn<(context: PreparedCliRunContext) => Promise<CliOutput>>(),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({ prepareCliRunContext }));
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));

describe("CLI operator model execution", () => {
  it("cancels a removed logical model and rejects late output without revoking a surviving model", async () => {
    const cfg = {
      agents: { defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } } },
    };
    let policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
    const listeners = new Set<() => void>();
    const sourceAbort = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "fixture-person",
      scopes: ["operator.write"],
      signal: sourceAbort.signal,
      assertCurrent: () => {},
      get modelPolicy() {
        return policy;
      },
      onModelPolicyChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const context = buildPreparedCliRunContext({
      provider: "google-gemini-cli",
      model: "transport-alias",
      backend: { sessionMode: "none" },
      runId: "cli-operator-model-execution",
      config: cfg,
    });
    const cleanup = vi.fn(async () => {});
    prepareCliRunContext.mockImplementation(async (params) => {
      const admittedRunContext = params.admittedRunContext;
      if (!admittedRunContext) {
        throw new Error("CLI model policy fixture requires an admitted run");
      }
      return {
        ...context,
        params: { ...params, admittedRunContext },
        preparedBackend: { ...context.preparedBackend, cleanup },
      };
    });
    const started = createDeferred<AbortSignal | undefined>();
    const complete = createDeferred();
    executePreparedCliRun.mockImplementationOnce(async (prepared) => {
      started.resolve(prepared.params.abortSignal);
      await complete.promise;
      return { text: "removed model output" };
    });
    executePreparedCliRun.mockResolvedValue({ text: "surviving model output" });
    const admission = prepareSystemAgentRunAdmission(
      cfg,
      context.params.runId,
      "main",
      "cli-model-execution-test",
      undefined,
      authority,
    );
    const params = { ...context.params, admittedRunContext: await admission.admit("embedded") };
    const operation = runCliAgent({
      ...params,
      requesterModel: { provider: "fixture", model: "a" },
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      const signal = await started.promise;
      expect(signal?.aborted).toBe(false);
      policy = prepareOperatorModelPolicy({
        cfg,
        policy: { deny: ["fixture/a"] },
        manifestPlugins: [],
      });
      for (const listener of listeners) {
        listener();
      }
      expect(signal?.aborted).toBe(true);
      expect(sourceAbort.signal.aborted).toBe(false);
      expect(authority.assertCurrent).not.toThrow();
      complete.resolve();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("operator role cannot use this model"),
      });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);

      const result = await runCliAgent({
        ...params,
        requesterModel: { provider: "fixture", model: "b" },
      });
      expect(result.payloads).toEqual([{ text: "surviving model output" }]);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(listeners.size).toBe(0);
    } finally {
      complete.resolve();
      await outcome;
      admission.close();
    }
  });
});
