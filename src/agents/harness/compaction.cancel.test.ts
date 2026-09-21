import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import { maybeCompactAgentHarnessSession } from "./compaction.js";
import { clearAgentHarnesses, registerAgentHarness } from "./registry.js";
import type { AgentHarness } from "./types.js";

const compactAuthMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
  prepareAgentRuntimeAuth: vi.fn(),
  resolveModelAsync: vi.fn(),
}));
vi.mock("../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth.js")>()),
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: compactAuthMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  getApiKeyForModelCore: compactAuthMocks.getApiKeyForModelCore,
}));
vi.mock("../embedded-agent-runner/model.js", () => ({
  resolveModelAsync: compactAuthMocks.resolveModelAsync,
}));
vi.mock("../runtime-plan/prepare-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-plan/prepare-auth.js")>()),
  prepareAgentRuntimeAuth: compactAuthMocks.prepareAgentRuntimeAuth,
}));
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));

let state: OpenClawTestState;
let generation: ReturnType<typeof createModelGenerationFixture>;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "compaction-cancel", applyEnv: false });
  resetModelGenerationFixtureState();
  generation = createModelGenerationFixture({
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    config: {},
    label: "compaction-cancel",
  });
  publishCurrentModelGeneration(generation);
});

afterEach(async () => {
  clearAgentHarnesses();
  resetModelGenerationFixtureState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.resetAllMocks();
  await state.cleanup();
});

describe("harness compaction cancellation", () => {
  it.each(["initial model lookup", "auth-route rematerialization"])(
    "does not start harness compaction when %s is cancelled",
    async (stage) => {
      const controller = new AbortController();
      const cancelled = new Error("Compaction model preparation cancelled");
      const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
        ok: true,
        compacted: false,
      }));
      registerAgentHarness(
        {
          id: "copilot",
          label: "Compaction cancellation fixture",
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            throw new Error("Compaction must not start inference");
          },
          compact,
        },
        { ownerPluginId: "copilot" },
      );
      if (stage === "auth-route rematerialization") {
        compactAuthMocks.resolveModelAsync.mockResolvedValueOnce({
          model: {
            id: "proxy-model",
            provider: "local-proxy",
            api: "openai-responses",
            baseUrl: "https://proxy.example/v1",
          },
        });
        compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({
            "local-proxy:stale": createApiKeyCredential("local-proxy", "stale-key"),
          }),
        );
        const directPlan = {
          providerForAuth: "local-proxy",
          authProfileProviderForAuth: "local-proxy",
          selectedAuthMode: "api_key" as const,
        };
        const profilePlan = {
          ...directPlan,
          forwardedAuthProfileId: "local-proxy:stale",
          forwardedAuthProfileSource: "auto" as const,
        };
        compactAuthMocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
          plan: profilePlan,
          attempts: [
            {
              kind: "profile" as const,
              profileId: "local-proxy:stale",
              plan: profilePlan,
              allowAuthProfileFallback: false,
            },
            { kind: "direct" as const, plan: directPlan, requiresPriorProfileAttempt: true },
          ],
        });
        compactAuthMocks.getApiKeyForModelCore.mockRejectedValueOnce(new Error("stale profile"));
      }
      compactAuthMocks.resolveModelAsync.mockImplementationOnce(async () => {
        controller.abort(cancelled);
        throw cancelled;
      });

      await expect(
        maybeCompactAgentHarnessSession(
          {
            sessionId: "session-1",
            sessionKey: "agent:main:main",
            sessionFile: state.path("session.jsonl"),
            workspaceDir: state.workspaceDir,
            agentDir: state.agentDir(),
            config: {},
            provider: "local-proxy",
            model: "proxy-model",
            agentHarnessId: "copilot",
            abortSignal: controller.signal,
          },
          { preparedModelRuntime: generation.preparedModelRuntime },
        ),
      ).rejects.toBe(cancelled);
      expect(compact).not.toHaveBeenCalled();
    },
  );
});
