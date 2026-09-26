import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it.each(["manual", "required_preflight", "source revocation"] as const)(
    "keeps the original model authority through registered %s compaction and closes the host afterward",
    async (dispatch) => {
      const config = { agents: { defaults: { model: "fixture/allowed" } } };
      const modelPolicy = prepareOperatorModelPolicy({
        cfg: config,
        policy: {},
        manifestPlugins: [],
      });
      let sourceHolds = 0;
      let sourceActive = true;
      const sourceReleased = createDeferredCore();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "compaction-source",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!sourceActive) {
            throw new Error("Compaction source revoked");
          }
        },
        modelPolicy,
        retain: () => {
          sourceHolds += 1;
          return () => {
            sourceHolds -= 1;
            if (sourceHolds === 0) {
              sourceReleased.resolve();
            }
          };
        },
      });
      let observedHost: AgentHarnessHostCapabilities | undefined;
      const compact = vi.fn(
        async (
          params: Parameters<NonNullable<AgentHarness["compact"]>>[0] & {
            hostCapabilities?: AgentHarnessHostCapabilities;
          },
        ) => {
          const host = params.hostCapabilities;
          if (!host?.retainSourceAuthority) {
            throw new Error("Registered compaction received no host model authority");
          }
          observedHost = host;
          host.assertActive();
          const retained = host.retainSourceAuthority();
          if (!retained?.bindModelExecution) {
            throw new Error("Registered compaction lost its original operator source");
          }
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
              sourceActive = false;
            }
            execution?.assertCurrent();
            return { ok: true, compacted: true };
          } finally {
            execution?.release();
            retained.release();
          }
        },
      );
      registerAgentHarness(
        {
          id: "codex",
          label: "Compaction source fixture",
          nativeModelPolicySupport: "exact",
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            throw new Error("Compaction must use its registered control entry");
          },
          compact,
        },
        { ownerPluginId: "codex", nativeCompaction: compact },
      );
      const options = {
        preparedModelRuntime: generation.preparedModelRuntime,
        sourceAuthority: { assertActive: () => {}, operatorAuthority },
        ...(dispatch === "required_preflight" ? { nativeCompactionRequest: dispatch } : {}),
      };
      const operation = maybeCompactAgentHarnessSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionFile: state.path("session.jsonl"),
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          agentHarnessId: "codex",
          config,
          trigger: "manual",
        },
        options,
      );
      if (dispatch === "source revocation") {
        await expect(operation).rejects.toThrow("Compaction source revoked");
      } else {
        await expect(operation).resolves.toMatchObject({ ok: true, compacted: true });
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
          {
            preparedModelRuntime: generation.preparedModelRuntime,
            sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
          },
        ),
      ).rejects.toBe(cancelled);
      expect(compact).not.toHaveBeenCalled();
    },
  );

  it("preserves the unknown-model guard for a registered compactor without exact model support", async () => {
    const config = { agents: { defaults: { model: "fixture/allowed" } } };
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "restricted-compaction-source",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({ cfg: config, policy: {}, manifestPlugins: [] }),
    });
    const compact = vi.fn<NonNullable<AgentHarness["compact"]>>(async () => ({
      ok: true,
      compacted: true,
    }));
    registerAgentHarness(
      {
        id: "copilot",
        label: "Unqualified compaction fixture",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async () => {
          throw new Error("Compaction must use its registered control entry");
        },
        compact,
      },
      { ownerPluginId: "copilot" },
    );
    await expect(
      maybeCompactAgentHarnessSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          sessionFile: state.path("session.jsonl"),
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          agentHarnessId: "copilot",
          config,
          trigger: "manual",
        },
        {
          preparedModelRuntime: generation.preparedModelRuntime,
          sourceAuthority: { assertActive: () => {}, operatorAuthority },
        },
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
    const compact = vi.fn(
      async (
        params: Parameters<NonNullable<AgentHarness["compact"]>>[0] & {
          hostCapabilities?: AgentHarnessHostCapabilities;
        },
      ) => {
        const host = params.hostCapabilities;
        if (!host) {
          throw new Error("Registered compaction received no host model authority");
        }
        hosts.push(host);
        const tail = hosts.length === 1 ? firstTail : secondTail;
        // A logical non-outcome leaves accepted native work draining; neither caller is revoked.
        void trackAsyncWork(() => tail.promise);
        return { ok: false, compacted: false, reason: "native tail pending" };
      },
    );
    registerAgentHarness(
      {
        id: "codex",
        label: "Concurrent compaction fixture",
        nativeModelPolicySupport: "exact",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async () => {
          throw new Error("Compaction must use its registered control entry");
        },
        compact,
      },
      { ownerPluginId: "codex" },
    );
    const params = {
      runId: "same-outer-run",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: state.path("session.jsonl"),
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir(),
      agentHarnessId: "codex",
      config: {},
      trigger: "manual" as const,
    };
    const options = {
      preparedModelRuntime: generation.preparedModelRuntime,
      sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined },
    };
    try {
      await expect(
        firstWork.run(() => maybeCompactAgentHarnessSession(params, options)),
      ).resolves.toMatchObject({ reason: "native tail pending" });
      await expect(
        secondWork.run(() => maybeCompactAgentHarnessSession(params, options)),
      ).resolves.toMatchObject({ reason: "native tail pending" });
      expect(compact).toHaveBeenCalledTimes(2);
      const [firstHost, secondHost] = hosts;
      if (!firstHost || !secondHost) {
        throw new Error("Expected both registered compaction hosts");
      }
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
