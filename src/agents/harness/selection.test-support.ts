import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
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

export function createHarnessAttemptParams(
  admittedRunContext: AdmittedRunContext,
  config?: OpenClawConfig,
): EmbeddedRunAttemptParams {
  return {
    admittedRunContext,
    prompt: "hello",
    sessionId: "session-1",
    runId: admittedRunContext.operationalRunInstance.runId,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
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
    const fixture = readFixture();
    const preparedModelRuntime = options.preparedModelRuntime ?? {
      ...createModelGenerationFixture({
        agentDir: fixture.state.agentDir(),
        workspaceDir: fixture.state.workspaceDir,
        config: params.config ?? {},
        createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
        label: "harness-test",
      }).preparedModelRuntime,
      pluginRegistry: getPluginRegistryForContext() ?? undefined,
    };
    const sourceAdmission = fixture.admittedRunContext;
    return maybeCompactAgentHarnessSessionImpl(params, {
      ...options,
      preparedModelRuntime,
      sourceAuthority: options.sourceAuthority ?? {
        operatorAuthority: undefined,
        assertActive: () => {
          if (!getAdmittedRunDelegatedAuthority(sourceAdmission)) {
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
