import { afterEach, vi } from "vitest";
import { resolveSessionStorePathCore, type SessionEntry } from "../../../config/sessions.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { registerAgentHarness } from "../../harness/registry.js";
import type { AgentHarness } from "../../harness/types.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.types.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../model.generation-scope.test-support.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { prepareEmbeddedRunRuntime } from "./runtime.js";
import { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";

const states: OpenClawTestState[] = [];
afterEach(async () => {
  resetModelGenerationFixtureState();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
  }
});

export async function createModelOwnershipFixture(
  config: OpenClawConfig = {},
  nativeOwner?: AgentHarness["resolveSessionRuntimeOwnership"],
  asyncNativeOwner?: AgentHarness["resolveSessionRuntimeOwnershipAsync"],
) {
  const state = await createOpenClawTestState({ label: "model-ownership" });
  states.push(state);
  const generation = createModelGenerationFixture({
    label: "ownership",
    provider: "openai",
    requestProvider: "openai",
    modelId: "fixture-model",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    runtimeApi: "openai-responses",
    runtimeBaseUrl: "https://api.openai.com/v1",
    config,
  });
  publishCurrentModelGeneration(generation);
  const harness: AgentHarness = {
    id: "codex",
    label: "Native fixture",
    authBootstrap: "harness",
    supports: ({ provider, modelProvider }) =>
      provider !== "openai"
        ? { supported: false }
        : modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
    ...(nativeOwner ? { resolveSessionRuntimeOwnership: nativeOwner } : {}),
    ...(asyncNativeOwner ? { resolveSessionRuntimeOwnershipAsync: asyncNativeOwner } : {}),
    runAttempt: vi.fn<AgentHarness["runAttempt"]>(),
  };
  registerAgentHarness(harness);
  const runParams: RunEmbeddedAgentParams = {
    config,
    agentId: "main",
    sessionId: "model-chat",
    sessionKey: "agent:main:model-chat",
    prompt: "hello",
    runId: "ownership-run",
    timeoutMs: 5_000,
    workspaceDir: state.workspaceDir,
    agentHarnessId: "codex",
    agentHarnessRuntimeOverride: "codex",
    modelSelectionLocked: true,
  };
  const target = {
    agentId: "main",
    sessionKey: runParams.sessionKey!,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry: SessionEntry = {
    sessionId: runParams.sessionId,
    updatedAt: 1,
    modelSelectionLocked: true,
    ...(nativeOwner || asyncNativeOwner
      ? { agentHarnessId: "codex" }
      : {
          pluginOwnerId: "catalog-owner",
          providerOverride: "openai",
          modelOverride: "fixture-model",
          agentRuntimeOverride: "codex",
        }),
  };
  await replaceSessionEntry(target, entry);
  const resolve = async (
    assertCurrent = () => {},
    preparedModelRuntime: PreparedModelRuntimeSnapshot = generation.preparedModelRuntime,
    sessionAdmission?: Awaited<ReturnType<typeof assertAgentHarnessRunAdmission>>,
    hookRunner?: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookRunner"],
  ) =>
    resolveEmbeddedRunModelSetup({
      assertCurrent,
      runParams,
      sessionAdmission: sessionAdmission ?? (await assertAgentHarnessRunAdmission(runParams)),
      provider: generation.provider,
      modelId: generation.modelId,
      agentDir: generation.preparedModelRuntime.agentDir,
      workspaceDir: generation.preparedModelRuntime.workspaceDir,
      globalLane: "test",
      hookRunner,
      hookContext: {
        sessionId: runParams.sessionId,
        workspaceDir: runParams.workspaceDir,
      },
      onHooksResolved: () => {},
      preparedModelRuntime,
    });
  const withRuntime = async (
    overrides: Partial<RunEmbeddedAgentParams>,
    use: (
      runtime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>,
      admission: ReturnType<typeof prepareSystemAgentRunAdmission>,
    ) => void | Promise<void>,
    preparedModelRuntime: PreparedModelRuntimeSnapshot = generation.preparedModelRuntime,
  ) => {
    const actualParams = { ...runParams, ...overrides };
    const admission = prepareSystemAgentRunAdmission(
      config,
      actualParams.runId,
      "main",
      "ownership-test",
    );
    let runtime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>> | undefined;
    try {
      runtime = await prepareEmbeddedRunRuntime({
        assertCurrent: () => {},
        runParams: { ...actualParams, preparedRunAdmission: admission },
        sessionAdmission: await assertAgentHarnessRunAdmission(actualParams),
        provider: actualParams.provider ?? generation.provider,
        modelId: actualParams.model ?? generation.modelId,
        agentDir: generation.preparedModelRuntime.agentDir,
        workspaceDir: actualParams.workspaceDir,
        globalLane: "test",
        hookRunner: undefined,
        hookContext: { sessionId: entry.sessionId, workspaceDir: actualParams.workspaceDir },
        markStartupStage: () => {},
        notifyExecutionPhase: () => {},
        fallbackConfigured: false,
        preparedModelRuntime,
      });
      await use(runtime, admission);
    } finally {
      runtime?.stopRuntimeAuthRefreshTimer();
      admission.close();
    }
  };
  return { state, generation, harness, target, entry, runParams, resolve, withRuntime };
}
