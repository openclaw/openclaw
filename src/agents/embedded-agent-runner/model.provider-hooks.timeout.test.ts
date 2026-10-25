import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { guardModelFixtureAuth } from "./model.fixture.test-support.js";
import { resolveModelAsync } from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./run/llm-idle-timeout.js";

const PROVIDER = "ai-brick";
const MODEL_ID = "ornith-1.0-35b";
const CONFIGURED_TIMEOUT_MS = 1_000;
const HOOK_TIMEOUT_MS = 2_500;

type RebuildingHookStage = "model" | "transport";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "provider-timeout" });
  const auth = guardModelFixtureAuth(state.root);
  return async () => {
    try {
      auth.verify();
    } finally {
      auth.spy.mockRestore();
      await state.cleanup();
    }
  };
});

function rebuildProviderModel(
  model: ProviderRuntimeModel,
  requestTimeoutMs?: number,
): ProviderRuntimeModel {
  const rebuilt = { ...model };
  delete rebuilt.requestTimeoutMs;
  if (requestTimeoutMs !== undefined) {
    rebuilt.requestTimeoutMs = requestTimeoutMs;
  }
  return rebuilt;
}

function createRebuildingRuntimeHooks(
  stage: RebuildingHookStage,
  requestTimeoutMs?: number,
): ProviderRuntimeHooks {
  const hooks: ProviderRuntimeHooks = createProviderRuntimeTestMock();
  if (stage === "model") {
    hooks.normalizeProviderResolvedModelWithPlugin = ({ context }) =>
      rebuildProviderModel(context.model, requestTimeoutMs);
  } else {
    hooks.applyProviderResolvedTransportWithPlugin = ({ context }) =>
      rebuildProviderModel(context.model, requestTimeoutMs);
  }
  return hooks;
}

async function resolveProviderModel(
  runtimeHooks: ProviderRuntimeHooks,
): Promise<ProviderRuntimeModel> {
  const result = await resolveModelAsync(
    PROVIDER,
    MODEL_ID,
    state.agentDir(),
    {
      models: {
        providers: {
          [PROVIDER]: {
            baseUrl: "http://127.0.0.1:8123/v1",
            api: "openai-completions",
            timeoutSeconds: CONFIGURED_TIMEOUT_MS / 1_000,
            models: [{ ...makeModel(MODEL_ID), contextWindow: 8_192, maxTokens: 512 }],
          },
        },
      },
    },
    {
      authStorage: { mocked: true } as never,
      modelRegistry: { find: () => null, getProviderMetadataOwners: () => undefined } as never,
      runtimeHooks,
      skipAgentDiscovery: true,
      workspaceDir: state.workspaceDir,
    },
  );
  if (!result.model) {
    throw new Error(`Expected a resolved provider model: ${result.error ?? "unknown error"}`);
  }
  return result.model as ProviderRuntimeModel;
}

describe("provider request timeout across rebuilding runtime hooks", () => {
  it.each([
    ["transport", undefined, CONFIGURED_TIMEOUT_MS],
    ["model", undefined, CONFIGURED_TIMEOUT_MS],
    ["model", HOOK_TIMEOUT_MS, HOOK_TIMEOUT_MS],
  ] as const)(
    "preserves timeout through the %s hook (override %s)",
    async (stage, override, expected) => {
      const model = await resolveProviderModel(createRebuildingRuntimeHooks(stage, override));
      expect(model.requestTimeoutMs).toBe(expected);
      const params = { model, modelRequestTimeoutMs: model.requestTimeoutMs };
      expect(resolveLlmFirstEventTimeoutMs(params)).toBe(expected);
      expect(resolveLlmIdleTimeoutMs(params)).toBe(expected);
    },
  );
});
