import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginRegistryForContext, requireActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { createModelGenerationFixture } from "../embedded-agent-runner/model.generation-scope.test-support.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { retainPreparedPluginRegistry } from "../prepared-model-runtime.plugin-lifetime.js";
import { maybeCompactAgentHarnessSession as maybeCompactAgentHarnessSessionImpl } from "./compaction.js";
import { createBaseAttemptParams } from "./lifecycle.test-support.js";

export function createHarnessAttemptParams(
  admittedRunContext: AdmittedRunContext,
  config?: OpenClawConfig,
): EmbeddedRunAttemptParams {
  return {
    ...createBaseAttemptParams(),
    admittedRunContext,
    agentId: "main",
    runId: admittedRunContext.operationalRunInstance.runId,
    config,
  } as EmbeddedRunAttemptParams;
}

export function createHarnessCompactionFixture(
  readFixture: () => { state: OpenClawTestState; admittedRunContext: AdmittedRunContext },
) {
  return function maybeCompactAgentHarnessSession(
    params: Parameters<typeof maybeCompactAgentHarnessSessionImpl>[0],
    options: Partial<Parameters<typeof maybeCompactAgentHarnessSessionImpl>[1]> = {},
  ) {
    const { state, admittedRunContext } = readFixture();
    const preparedModelRuntime = options.preparedModelRuntime ?? {
      ...createModelGenerationFixture({
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        config: params.config ?? {},
        createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
        label: "harness-test",
      }).preparedModelRuntime,
      pluginRegistry: getPluginRegistryForContext() ?? undefined,
    };
    return maybeCompactAgentHarnessSessionImpl(params, {
      ...options,
      preparedModelRuntime,
      sourceAuthority: options.sourceAuthority ?? {
        operatorAuthority: undefined,
        assertActive: () => {
          if (!getAdmittedRunDelegatedAuthority(admittedRunContext)) {
            throw new Error("Harness selection fixture admission is closed");
          }
        },
      },
    });
  };
}

export async function withOwnedHarnessGeneration<Registered, Result>(
  generation: ReturnType<typeof createModelGenerationFixture>,
  register: () => Registered,
  run: (registered: Registered) => Promise<Result>,
): Promise<Result> {
  requireActivePluginRegistry();
  const release = retainPreparedPluginRegistry(generation.pluginRegistry);
  if (!release) {
    throw new Error("Harness generation fixture must own its prepared registry");
  }
  try {
    const registered = withPluginRuntimeGenerationScope(generation.preparedModelRuntime, register);
    // The caller stays outside registration scope to exercise production generation binding.
    return await run(registered);
  } finally {
    await release();
  }
}

export const privateHarnessParamCases = [
  { field: "thinkingExplicit", value: false },
  {
    field: "runtimePluginToolGrant",
    value: { pluginId: "grant-owner", toolNames: ["optional_tool"] },
  },
  { field: "__openclawSourceReplyDeliveryRuntime", value: { currentMode: "automatic" } },
  { field: "compactionCountOwner", value: "caller" },
  { field: "completionCheck", value: { unfinishedPlan: true, checked: false } },
  { field: "preparedSessionTarget", value: { target: {}, assertCurrent: () => undefined } },
  { field: "bindWatchdogAttempt", value: () => undefined },
  { field: "onContextAccountingEvent", value: () => undefined },
  { field: "onCompactionRequestBudget", value: () => undefined },
  { field: "prepareContinuationRetryCount", value: () => undefined },
] as const;
