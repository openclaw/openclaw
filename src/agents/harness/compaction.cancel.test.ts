import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertProviderAuthAuthority,
  attachProviderAuthAuthority,
} from "../../plugins/provider-auth-authority.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "../embedded-agent-runner/model.generation-scope.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { maybeCompactAgentHarnessSession } from "./compaction.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
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
  ensureAuthProfileStoreAsync: compactAuthMocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreWithoutExternalProfilesAsync:
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
type Compact = NonNullable<AgentHarness["compact"]>;
type CompactParams = Parameters<Compact>[0] & {
  hostCapabilities?: AgentHarnessHostCapabilities;
};
const compacted = { ok: true, compacted: true };
const restrictedConfig = { agents: { defaults: { model: "fixture/allowed" } } };
const proxyModel = makeProviderModelFixture({
  provider: "local-proxy",
  id: "proxy-model",
  api: "openai-responses",
  baseUrl: "https://proxy.example/v1",
});
const directPlan = {
  providerForAuth: proxyModel.provider,
  authProfileProviderForAuth: proxyModel.provider,
  selectedAuthMode: "api_key" as const,
};
const proxyTarget = { provider: proxyModel.provider, model: proxyModel.id };

function operatorSource(
  overrides: Partial<Parameters<typeof createAdmittedRunOperatorAuthority>[0]> = {},
) {
  return createAdmittedRunOperatorAuthority({
    profileId: "compaction-source",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({
      cfg: restrictedConfig,
      policy: {},
      manifestPlugins: [],
    }),
    ...overrides,
  });
}

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

function registerCompactor(
  implementation: Compact = async () => ({ ...compacted }),
  mode?: "exact" | "native",
) {
  const compact = vi.fn(implementation);
  const id = mode ? "codex" : "copilot";
  registerAgentHarness(
    {
      id,
      ...(mode ? { nativeModelPolicySupport: "exact" as const } : {}),
      label: "Compaction fixture",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => {
        throw new Error("Compaction must use its registered control entry");
      },
      compact,
    },
    { ownerPluginId: id, nativeCompaction: mode === "native" ? compact : undefined },
  );
  return compact;
}

type CompactionOptions = Parameters<typeof maybeCompactAgentHarnessSession>[1];
function compactSession(
  params: Partial<Parameters<typeof maybeCompactAgentHarnessSession>[0]>,
  sourceAuthority: Partial<CompactionOptions["sourceAuthority"]> = {},
  options: Partial<Omit<CompactionOptions, "sourceAuthority">> = {},
) {
  return maybeCompactAgentHarnessSession(
    {
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: state.path("session.jsonl"),
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir(),
      agentHarnessId: "copilot",
      config: {},
      ...params,
    },
    {
      preparedModelRuntime: generation.preparedModelRuntime,
      sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined, ...sourceAuthority },
      ...options,
    },
  );
}

describe("harness compaction cancellation", () => {
  it.each([
    { supplied: false, revoke: false },
    { supplied: false, revoke: true },
    { supplied: true, revoke: false },
    { supplied: true, revoke: true },
  ])(
    "retains credential authority through compaction supplied=$supplied revoke=$revoke",
    async ({ supplied, revoke }) => {
      const credential = new AbortController();
      const retired = new Error("Compaction credential retired");
      const assertCurrent = () => credential.signal.throwIfAborted();
      compactAuthMocks.resolveModelAsync.mockResolvedValue({ model: proxyModel });
      compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
        createAuthProfileStoreFixture({}),
      );
      compactAuthMocks.prepareAgentRuntimeAuth.mockReturnValue({
        plan: directPlan,
        attempts: [{ kind: "direct", plan: directPlan }],
      });
      compactAuthMocks.getApiKeyForModelCore.mockResolvedValue(
        attachProviderAuthAuthority(
          { apiKey: "fixture-key", mode: "api-key", source: "plugin" },
          assertCurrent,
        ),
      );
      const compact = registerCompactor(async (params) => {
        expect(params.resolvedApiKey).toBe("fixture-key");
        credential.abort(retired);
        expect(() => assertProviderAuthAuthority(params.runtimeModel)).toThrow(retired);
        return { ...compacted };
      });
      const operation = compactSession(
        {
          ...proxyTarget,
          runtimeModel: supplied
            ? attachProviderAuthAuthority(proxyModel, assertCurrent)
            : undefined,
          resolvedApiKey: supplied ? "fixture-key" : undefined,
        },
        {
          prepareDispatch: async () => {
            if (revoke) {
              credential.abort(retired);
            }
          },
        },
      );
      if (revoke) {
        await expect(operation).rejects.toThrow(retired);
        expect(compact).not.toHaveBeenCalled();
      } else {
        await expect(operation).resolves.toMatchObject(compacted);
        expect(compact).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["manual", "required_preflight", "source revocation"] as const)(
    "keeps the original model authority through registered %s compaction and closes the host afterward",
    async (dispatch) => {
      let sourceHolds = 0;
      const source = new AbortController();
      const sourceReleased = createDeferredCore();
      const operatorAuthority = operatorSource({
        assertCurrent: () => source.signal.throwIfAborted(),
        retain: () => {
          sourceHolds += 1;
          return () => {
            if (--sourceHolds === 0) {
              sourceReleased.resolve();
            }
          };
        },
      });
      let observedHost: AgentHarnessHostCapabilities | undefined;
      const compact = registerCompactor(async (params: CompactParams) => {
        const host = params.hostCapabilities;
        assert(host?.retainSourceAuthority);
        observedHost = host;
        host.assertActive();
        const retained = host.retainSourceAuthority();
        assert(retained?.bindModelExecution);
        const execution = retained.bindModelExecution({ provider: "fixture", model: "allowed" });
        try {
          expect(retained.sourceIdentity).toBe(operatorAuthority.source);
          expect(execution).toBeDefined();
          expect(() =>
            retained.bindModelExecution?.({ provider: "fixture", model: "denied" }),
          ).toThrow("operator role cannot use this model");
          await Promise.resolve();
          host.assertActive();
          if (dispatch === "source revocation") {
            source.abort(new Error("Compaction source revoked"));
          }
          execution?.assertCurrent();
          return { ...compacted };
        } finally {
          execution?.release();
          retained.release();
        }
      }, "native");
      const operation = compactSession(
        { agentHarnessId: "codex", config: restrictedConfig, trigger: "manual" },
        { operatorAuthority },
        { nativeCompactionRequest: dispatch === "required_preflight" ? dispatch : undefined },
      );
      if (dispatch === "source revocation") {
        await expect(operation).rejects.toThrow("Compaction source revoked");
      } else {
        await expect(operation).resolves.toMatchObject(compacted);
      }
      await sourceReleased.promise;
      expect(compact).toHaveBeenCalledOnce();
      expect(observedHost).toBeDefined();
      expect(() => observedHost?.assertActive()).toThrow("no longer active");
      expect(sourceHolds).toBe(0);
    },
  );

  it.each(["initial model lookup", "auth-route rematerialization"])(
    "does not start harness compaction when %s is cancelled",
    async (stage) => {
      const controller = new AbortController();
      const cancelled = new Error("Compaction model preparation cancelled");
      const compact = registerCompactor(async () => ({ ok: true, compacted: false }));
      if (stage === "auth-route rematerialization") {
        compactAuthMocks.resolveModelAsync.mockResolvedValueOnce({ model: proxyModel });
        compactAuthMocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
          createAuthProfileStoreFixture({
            "local-proxy:stale": createApiKeyCredential("local-proxy", "stale-key"),
          }),
        );
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
        compactSession({
          ...proxyTarget,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(cancelled);
      expect(compact).not.toHaveBeenCalled();
    },
  );

  it("preserves the unknown-model guard for a registered compactor without exact model support", async () => {
    const compact = registerCompactor();
    await expect(
      compactSession(
        { config: restrictedConfig, trigger: "manual" },
        { operatorAuthority: operatorSource() },
      ),
    ).rejects.toThrow("operator role cannot use this model");
    expect(compact).not.toHaveBeenCalled();
  });

  it("keeps same-session compaction admissions independent while native tails settle", async () => {
    const firstTail = createDeferredCore();
    const secondTail = createDeferredCore();
    const firstWork = new AsyncWorkScope();
    const secondWork = new AsyncWorkScope();
    const hosts: AgentHarnessHostCapabilities[] = [];
    const compact = registerCompactor(async (params: CompactParams) => {
      const host = params.hostCapabilities;
      assert(host);
      hosts.push(host);
      const tail = hosts.length === 1 ? firstTail : secondTail;
      // A logical non-outcome leaves accepted native work draining; neither caller is revoked.
      void trackAsyncWork(() => tail.promise);
      return { ok: false, compacted: false, reason: "native tail pending" };
    }, "exact");
    const params = {
      runId: "same-outer-run",
      agentHarnessId: "codex",
      trigger: "manual" as const,
    };
    try {
      for (const work of [firstWork, secondWork]) {
        await expect(work.run(() => compactSession(params))).resolves.toMatchObject({
          reason: "native tail pending",
        });
      }
      expect(compact).toHaveBeenCalledTimes(2);
      const [firstHost, secondHost] = hosts;
      assert(firstHost && secondHost);
      expect(() => firstHost.assertActive()).not.toThrow();
      expect(() => secondHost.assertActive()).not.toThrow();
      firstTail.resolve();
      await firstWork.drain();
      expect(() => firstHost.assertActive()).toThrow("no longer active");
      expect(() => secondHost.assertActive()).not.toThrow();
    } finally {
      firstTail.resolve();
      secondTail.resolve();
      await Promise.all([firstWork.drain(), secondWork.drain()]);
    }
  });
});
