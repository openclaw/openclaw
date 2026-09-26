import { resolveSessionStorePathCore, type SessionEntry } from "../../../config/sessions.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { registerAgentHarness } from "../../harness/registry.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
} from "../model.generation-scope.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";

export async function createModelSetupLifetimeFixture(params?: {
  config?: OpenClawConfig;
  modelSelectionLocked?: boolean;
}) {
  const config = params?.config ?? {};
  const modelSelectionLocked = params?.modelSelectionLocked ?? true;
  const state = await createOpenClawTestState({ label: "model-setup-lifetime" });
  const generation = createModelGenerationFixture({
    label: "lifetime",
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
    label: "Lifetime fixture",
    authBootstrap: "harness",
    supports: ({ provider }) =>
      provider === "openai" ? { supported: true } : { supported: false },
    runAttempt: () => {
      throw new Error("model setup tests do not dispatch a run");
    },
  };
  registerAgentHarness(harness);

  const runParams: RunEmbeddedAgentParams = {
    config,
    agentId: "main",
    sessionId: "model-lifetime-chat",
    sessionKey: "agent:main:model-lifetime-chat",
    prompt: "hello",
    runId: "model-lifetime-run",
    timeoutMs: 5_000,
    workspaceDir: state.workspaceDir,
    agentHarnessId: "codex",
    agentHarnessRuntimeOverride: "codex",
    modelSelectionLocked,
  };
  const target = {
    agentId: "main",
    sessionKey: runParams.sessionKey!,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry: SessionEntry = {
    sessionId: runParams.sessionId,
    updatedAt: 1,
    modelSelectionLocked,
    pluginOwnerId: "lifetime-catalog-owner",
    providerOverride: "openai",
    modelOverride: "fixture-model",
    agentRuntimeOverride: "codex",
  };
  await replaceSessionEntry(target, entry);

  const resolve = (
    assertCurrent = () => {},
    hookRunner?: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookRunner"],
    runParamsOverride: object = {},
  ) =>
    resolveEmbeddedRunModelSetup({
      assertCurrent,
      runParams: { ...runParams, ...runParamsOverride } as RunEmbeddedAgentInternalParams,
      sessionAdmission: assertAgentHarnessRunAdmission(runParams),
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
      preparedModelRuntime: generation.preparedModelRuntime,
    });

  return { state, generation, runParams, config, resolve };
}
