import "../../auth-profiles/external-auth.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { getProviderRequestAuth } from "../../../plugins/provider-auth-authority.js";
import * as providerRuntime from "../../../plugins/provider-runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "../../admitted-run-context.js";
import * as authorizationOwner from "../../auth-profiles/authorization.js";
import { createOAuthManager } from "../../auth-profiles/oauth-manager.js";
import * as profileLock from "../../auth-profiles/oauth-profile-lock.js";
import { readAuthProfileStoreForTest, storeWith } from "../../auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLockOrThrow } from "../../auth-profiles/profiles.js";
import {
  withSetupCredentialAccess,
  runOutsideSetupCredentialAccess,
} from "../../auth-profiles/setup-access.js";
import { writePersistedAuthProfileStoreRaw } from "../../auth-profiles/sqlite.js";
import { withAuthProfileStoreAgentDir } from "../../auth-profiles/store.js";
import * as contextLeaseOwner from "../../harness/context-engine-logical-turn.js";
import * as contextTurnOwner from "../../harness/context-engine-turn-begin.js";
import {
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  getApiKeyForModelCore,
} from "../../model-auth.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import * as modelResolver from "../model.js";
import { createEmbeddedAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import { runPreparedEmbeddedLoop } from "../run-loop.js";
import {
  provider,
  profileId,
  withRequestFixture,
} from "./auth-controller.request-auth.test-support.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import * as modelHarness from "./model-harness.js";
import * as modelSetup from "./model-setup.js";
import { createEmbeddedRunProgressController } from "./progress-controller.js";
import * as dispatchOwner from "./run-attempt-dispatch.js";
import { prepareEmbeddedRunTransport } from "./runtime-preparation.js";
import { prepareEmbeddedRunRuntime } from "./runtime.js";
import * as sessionPromptOwner from "./session-prompt-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("initializes local OAuth in the real bounded agent-exec auth scope without borrowing shared OAuth", async () => {
  await withRequestFixture(
    async ({ state, credential, agentDir, controller, authState, installed, refresh }) => {
      const sharedId = `${provider}:shared-only`;
      writePersistedAuthProfileStoreRaw(
        storeWith(sharedId, {
          ...credential,
          access: "synthetic-ambient-access",
          refresh: "synthetic-ambient-refresh",
          accountId: "ambient-account",
        }),
      );
      await withAuthProfileStoreAgentDir(agentDir, state.stateDir, async () => {
        const scoped = await ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir);
        expect(scoped.profiles[profileId]).toEqual(credential);
        expect(scoped.profiles[sharedId]).toBeUndefined();
        await expect(
          getApiKeyForModelCore({
            model: authState.models.effective,
            cfg: { plugins: { enabled: false } },
            profileId: sharedId,
            lockedProfile: true,
            allowAuthProfileFallback: false,
            agentDir,
          }),
        ).rejects.toThrow();
        await controller.initializeAuthProfile();
        expect(installed()).toBe("synthetic-access-before");
        expect(authState.lastProfileId).toBe(profileId);
        expect(getProviderRequestAuth(authState.models.effective)).toBeUndefined();
        expect(refresh).not.toHaveBeenCalled();
      });
    },
    { agentId: "exec-local", sharedStateOwner: true },
  );
});

it("verifies replacement OAuth only within its exact active setup scope without ambient account capture", async () => {
  await withRequestFixture(
    async ({ agentDir, controller, authState, installed, refresh }) => {
      const resolve = () =>
        getApiKeyForModelCore({
          model: authState.models.effective,
          cfg: { plugins: { enabled: false } },
          profileId,
          lockedProfile: true,
          allowAuthProfileFallback: false,
          agentDir,
        });
      await expect(resolve()).rejects.toThrow();
      await withSetupCredentialAccess({ profileId: `${provider}:other`, agentDir }, async () => {
        await expect(resolve()).rejects.toThrow();
      });
      await withSetupCredentialAccess({ profileId, agentDir: `${agentDir}-other` }, async () => {
        await expect(resolve()).rejects.toThrow();
      });
      const signal = new AbortController();
      await withSetupCredentialAccess({ profileId, agentDir, signal: signal.signal }, async () => {
        await runOutsideSetupCredentialAccess(async () => {
          await expect(resolve()).rejects.toThrow();
        });
        await controller.initializeAuthProfile();
        expect(installed()).toBe("synthetic-access-before");
        expect(authState.lastProfileId).toBe(profileId);
        expect(getProviderRequestAuth(authState.models.effective)).toBeUndefined();
        signal.abort();
        await expect(resolve()).rejects.toThrow();
      });
      await expect(resolve()).rejects.toThrow();
      expect(refresh).not.toHaveBeenCalled();
    },
    { replacement: true },
  );
});

it.each([undefined, "runtime-only"] as const)(
  "initializes a runtime external OAuth overlay with persistence=%s without a canonical row",
  async (persistence) => {
    await withRequestFixture(
      async ({ agentDir, authStore, controller, authState, installed, refresh }) => {
        expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toBeUndefined();
        expect(authStore.runtimeExternalProfileIds).toContain(profileId);
        const capture = vi.spyOn(authorizationOwner, "captureAuthProfileAuthorization");
        await controller.initializeAuthProfile();
        expect(installed()).toBe("synthetic-access-before");
        expect(authState.lastProfileId).toBe(profileId);
        expect(getProviderRequestAuth(authState.models.effective)).toBeUndefined();
        expect(capture).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toBeUndefined();
      },
      { externalProfile: { profileId, persistence } },
    );
  },
);

it.each(["persisted-external", "unrelated-overlay"] as const)(
  "retains canonical authorization for a stored selection with %s",
  async (ownership) => {
    await withRequestFixture(
      async ({ state, agentDir, authStore, controller, authState, installed }) => {
        expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toBeDefined();
        expect(authStore.runtimeExternalProfileIds ?? []).not.toContain(profileId);
        const capture = vi.spyOn(authorizationOwner, "captureAuthProfileAuthorization");
        await controller.initializeAuthProfile();
        expect(installed()).toBe("synthetic-access-before");
        expect(capture).toHaveBeenCalledOnce();
        expect(getProviderRequestAuth(authState.models.effective)).toBeDefined();
        await state.writeAuthProfiles({ version: 1, profiles: {} });
        await expect(controller.initializeAuthProfile()).rejects.toMatchObject({
          code: "MCP_AUTHORIZATION_RETIRED",
        });
        expect(capture).toHaveBeenCalledTimes(2);
      },
      {
        externalProfile:
          ownership === "persisted-external"
            ? { profileId, persistence: "persisted" }
            : { profileId: `${provider}:unrelated` },
      },
    );
  },
);

it.each([
  "exhausted",
  "canceled",
  "post-auth",
  "returned",
  "admission",
  "admitted",
  "session",
  "context",
  "context-stage",
  "execution",
] as const)(
  "owns actual captured account authorization through %s startup and handoff",
  async (scenario) => {
    await withRequestFixture(async ({ state, credential, authState }) => {
      if (scenario === "exhausted") {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            [profileId]: credential,
            [`${provider}:second`]: { ...credential, access: "synthetic-second-access" },
          },
        });
      }
      const model = authState.models.runtime;
      const harness = {
        id: "openclaw",
        label: "Startup fixture",
        supports: () => ({ supported: true as const }),
        runAttempt: vi.fn(),
      };
      // Model selection and installation precede the lifecycle under test. Keep
      // auth planning, controller creation, capture, writer facts and disposal real.
      const discovery = modelResolver.createEmptyAgentDiscoveryStores();
      vi.spyOn(modelResolver, "resolveModelAsync").mockResolvedValue({
        model,
        logicalRef: { provider, model: model.id },
        ...discovery,
      });
      vi.spyOn(modelSetup, "resolveEmbeddedRunModelSetup").mockResolvedValue({
        provider,
        modelId: model.id,
        requestedModelId: model.id,
        modelSelectionChangedByHook: false,
        requestStreamTransportOverrides: undefined,
        expectedHarnessArtifact: undefined,
        agentHarness: harness,
        pluginHarnessOwnsTransport: false,
        pinnedHarnessId: undefined,
        nativeModelOwned: false,
        observedRoutes: undefined,
        nativeSessionRuntime: undefined,
        modelConfigProvider: provider,
        model,
        ...discovery,
      });
      vi.spyOn(modelHarness, "selectEmbeddedRunHarness").mockReturnValue(harness);
      const captures: {
        handle: authorizationOwner.AuthProfileAuthorization;
        dispose: ReturnType<typeof vi.fn>;
      }[] = [];
      const capture = authorizationOwner.captureAuthProfileAuthorization;
      vi.spyOn(authorizationOwner, "captureAuthProfileAuthorization").mockImplementation(
        async (params) => {
          const handle = await capture(params);
          const dispose = vi.spyOn(handle, "dispose");
          captures.push({ handle, dispose });
          return handle;
        },
      );
      const abort = new AbortController();
      vi.spyOn(providerRuntime, "prepareProviderRuntimeAuth").mockImplementation(async () => {
        if (scenario === "exhausted") {
          throw new Error("fixture runtime-auth preparation failed");
        }
        if (scenario === "canceled") {
          abort.abort(new Error("fixture startup canceled"));
        }
        return undefined;
      });
      const runId = `startup-${scenario}`;
      const sessionKey = "agent:main:startup-session";
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "startup-fixture", state: "present" },
        },
        onAdmitted: () => {
          expect(captures).toHaveLength(1);
          captures[0]!.handle.assertCurrent();
          if (scenario === "admission") {
            throw new Error("fixture runtime admission denied");
          }
        },
      });
      const leases: contextLeaseOwner.ContextEngineLogicalTurnLease[] = [];
      const createLease = contextLeaseOwner.createContextEngineLogicalTurnLease;
      vi.spyOn(contextLeaseOwner, "createContextEngineLogicalTurnLease").mockImplementation(
        async (input) => {
          const lease = await createLease(input);
          leases.push(lease);
          return lease;
        },
      );
      if (scenario === "session") {
        vi.spyOn(sessionPromptOwner, "createEmbeddedRunSessionPromptState").mockRejectedValue(
          new Error("fixture session preparation failed"),
        );
      }
      if (scenario === "context") {
        vi.spyOn(contextTurnOwner, "beginContextEngineLogicalTurn").mockRejectedValue(
          new Error("fixture context preparation failed"),
        );
      }
      if (scenario === "execution") {
        vi.spyOn(dispatchOwner, "prepareAndDispatchEmbeddedRunAttempt").mockImplementation(
          async () => {
            captures[0]!.handle.assertCurrent();
            expect(captures[0]!.dispose).not.toHaveBeenCalled();
            expect(leases[0]!.disposed).toBe(false);
            throw new Error("fixture execution reached");
          },
        );
      }
      let runtime: Awaited<ReturnType<typeof prepareEmbeddedRunTransport>> | undefined;
      let admittedRuntime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>> | undefined;
      const writers: AsyncDisposable[] = [];
      try {
        const transportInput: Parameters<typeof prepareEmbeddedRunTransport>[0] = {
          assertCurrent: () => {},
          runParams: {
            runId,
            preparedRunAdmission: admission,
            sessionPersistence: "detached",
            sessionId: "startup-session",
            sessionKey,
            agentId: "main",
            prompt: "Synthetic startup",
            workspaceDir: state.workspaceDir,
            timeoutMs: 5000,
            config: { plugins: { enabled: false } },
            abortSignal: abort.signal,
            thinkLevel: "off",
          },
          provider,
          modelId: model.id,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          globalLane: "test",
          hookRunner: undefined,
          hookContext: { sessionId: "startup-session", workspaceDir: state.workspaceDir },
          markStartupStage: (stage) => {
            if (scenario === "post-auth" && stage === "auth") {
              throw new Error("fixture post-auth preparation failed");
            }
          },
          notifyExecutionPhase: () => {},
          fallbackConfigured: false,
        };
        const loopScenario = ["session", "context", "context-stage", "execution"].includes(
          scenario,
        );
        let preparing: Promise<unknown>;
        if (loopScenario) {
          let runParams = { ...transportInput.runParams, sessionFile: "startup-session" };
          const lifecycleGeneration = "startup-lifecycle";
          const laneController = createEmbeddedRunLaneController({
            getLifecycleGeneration: () => lifecycleGeneration,
            getParams: () => runParams,
            globalLane: "test",
            initialQueuedLifecycleGeneration: lifecycleGeneration,
            setLifecycleGeneration: () => {},
            setParams: (next) => {
              runParams = next;
            },
          });
          const refresh = createEmbeddedAgentPluginRuntimeRefresh(runParams);
          const startupStages = createStageTimingTracker(Date.now);
          const mark = startupStages.mark;
          vi.spyOn(startupStages, "mark").mockImplementation((stage) => {
            if (scenario === "context-stage" && stage === "context-engine") {
              captures[0]!.handle.assertCurrent();
              expect(leases[0]!.disposed).toBe(false);
              throw new Error("fixture context-stage failed");
            }
            return mark(stage);
          });
          preparing = runPreparedEmbeddedLoop(refresh, {
            ...transportInput,
            hookRunner: null,
            runParams,
            laneController,
            lifecycleGeneration,
            workspaceResolution: {
              agentId: "main",
              workspaceDir: state.workspaceDir,
              isCanonicalWorkspace: true,
              usedFallback: false,
            },
            isCanonicalWorkspace: true,
            isProbeSession: false,
            resolvedSessionKey: sessionKey,
            resolvedToolResultFormat: "markdown",
            startedAtMs: Date.now(),
            startupStages,
            emitStartupStageSummary: () => {},
            suspendForFailure: () => {},
            onInitialWriterPrepared: (writer) => {
              writers.push(writer);
            },
            progressController: createEmbeddedRunProgressController({
              attempt: runParams,
              noteLaneTaskProgress: () => {},
              startedAtMs: Date.now(),
            }),
          }).finally(() => refresh.close());
        } else if (scenario === "admission" || scenario === "admitted") {
          preparing = prepareEmbeddedRunRuntime(transportInput).then((result) => {
            admittedRuntime = result;
            return result;
          });
        } else {
          preparing = prepareEmbeddedRunTransport(transportInput).then((result) => {
            runtime = result;
            return result;
          });
        }
        if (scenario === "returned" || scenario === "admitted") {
          await preparing;
          expect(captures).toHaveLength(1);
          expect(captures[0]!.dispose).not.toHaveBeenCalled();
          captures[0]!.handle.assertCurrent();
          expect(
            getProviderRequestAuth((admittedRuntime ?? runtime)!.snapshot().effectiveModel),
          ).toBeDefined();
          if (admittedRuntime) {
            await admittedRuntime.releaseTransport();
          } else {
            runtime!.stopRuntimeAuthRefreshTimer();
          }
        } else {
          await expect(preparing).rejects.toThrow(
            scenario === "admission"
              ? "fixture runtime admission denied"
              : scenario === "session"
                ? "fixture session preparation failed"
                : scenario === "context"
                  ? "fixture context preparation failed"
                  : scenario === "context-stage"
                    ? "fixture context-stage failed"
                    : scenario === "execution"
                      ? "fixture execution reached"
                      : undefined,
          );
          expect(captures).toHaveLength(scenario === "exhausted" ? 2 : 1);
        }
        expect(writers).toHaveLength(loopScenario && scenario !== "session" ? 1 : 0);
        expect(leases).toHaveLength(loopScenario && scenario !== "session" ? 1 : 0);
        for (const lease of leases) {
          expect(lease.disposed).toBe(true);
        }
        for (const { handle, dispose } of captures) {
          expect(dispose).toHaveBeenCalledOnce();
          expect(() => handle.assertCurrent()).toThrow(/disconnected or replaced/);
        }
      } finally {
        runtime?.stopRuntimeAuthRefreshTimer();
        await admittedRuntime?.releaseTransport();
        for (const writer of writers) {
          await writer[Symbol.asyncDispose]();
        }
        for (const lease of leases) {
          await lease.dispose();
        }
        admission.close();
        // A red run must release its real resources after the assertions, too.
        for (const { handle } of captures) {
          handle.dispose();
        }
      }
    });
  },
);

it("renews the selected canonical OAuth owner between physical requests in one attempt", async () => {
  await withRequestFixture(
    async ({ state, credential, controller, authState, refresh, installed }) => {
      await controller.initializeAuthProfile();
      const capturedAttemptKey = installed();
      const requests: string[] = [];
      vi.spyOn(providerRuntime, "resolveProviderStreamFn").mockImplementation(
        ({ context: factory }) =>
          (_model, _context, options) => {
            const stream = createAssistantMessageEventStream();
            void (async () => {
              try {
                // The external transport consumes the optional host capability.
                const auth = await factory.requestAuth?.resolve({ signal: options?.signal });
                auth?.assertCurrent();
                requests.push(auth ? auth.apiKey : (options?.apiKey ?? ""));
                const message = makeAgentAssistantMessage({
                  content: [{ type: "text", text: "one result" }],
                  stopReason: "stop",
                });
                stream.push({ type: "done", reason: "stop", message });
              } catch (error) {
                stream.push({
                  type: "error",
                  reason: "error",
                  error: makeAgentAssistantMessage({
                    content: [],
                    stopReason: "error",
                    errorMessage: String(error),
                  }),
                });
              } finally {
                stream.end();
              }
            })();
            return stream;
          },
      );
      const stream = registerProviderStreamForModel({
        model: authState.models.effective,
        allowRuntimePluginLoad: false,
      });
      if (!stream) {
        throw new Error("Missing fixture stream");
      }
      const call = async () =>
        await (
          await stream(authState.models.effective, { messages: [] }, { apiKey: capturedAttemptKey })
        ).result();
      await call();
      await call();
      expect(refresh).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 3_600_001);
      expect((await call()).errorMessage).toBeUndefined();
      expect(requests).toEqual([
        "synthetic-access-before",
        "synthetic-access-before",
        "synthetic-access-after",
      ]);
      expect(refresh).toHaveBeenCalledOnce();
      expect(readAuthProfileStoreForTest(state.agentDir()).profiles[profileId]).toMatchObject({
        access: "synthetic-access-after",
        refresh: "synthetic-refresh-after",
        accountId: "account-a",
      });
      // An independent native owner publishes a refresh, preserving authorization.
      const rotation = {
        ...credential,
        access: "synthetic-canonical-rotation",
        refresh: "synthetic-canonical-refresh",
        expires: Date.now() + 3_600_000,
      };
      refresh.mockResolvedValueOnce(rotation);
      const owner = createOAuthManager();
      const current = readAuthProfileStoreForTest(state.agentDir());
      const currentCredential = current.profiles[profileId];
      if (currentCredential?.type !== "oauth") {
        throw new Error("Missing canonical credential");
      }
      await expect(
        owner.resolveOAuthAccess({
          store: current,
          credential: currentCredential,
          profileId,
          agentDir: state.agentDir(),
          forceRefresh: true,
        }),
      ).resolves.toMatchObject({ apiKey: "synthetic-canonical-rotation" });
      await call();
      expect(requests.at(-1)).toBe("synthetic-canonical-rotation");
      expect(refresh).toHaveBeenCalledTimes(2);
      await state.writeAuthProfiles(
        storeWith(profileId, {
          ...credential,
          accountId: "account-b",
          access: "wrong-account",
          expires: Date.now() + 3_600_000,
        }),
      );
      expect(await call()).toMatchObject({
        stopReason: "error",
        errorMessage: expect.stringContaining("disconnected or replaced"),
      });
      expect(requests).toHaveLength(4);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );
});

it.each(["during-prepare", "after-resolve"] as const)(
  "refuses a reconnected canonical account %s without an automation binding",
  async (boundary) => {
    await withRequestFixture(async ({ state, credential, controller, authState }) => {
      await controller.initializeAuthProfile();
      const capability = getProviderRequestAuth(authState.models.effective);
      if (!capability) {
        throw new Error("Missing request auth");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(providerRuntime, "prepareProviderRuntimeAuth").mockImplementation(async () => {
        if (boundary === "during-prepare") {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      });
      const pending = capability.resolve({});
      const outcome = pending.then(
        (auth) => ({ auth }),
        (error: unknown) => ({ error }),
      );
      if (boundary === "during-prepare") {
        await entered.promise;
      } else {
        await pending;
      }
      // Explicit reconnect retires authorization even when credential/account bytes match.
      await upsertAuthProfileWithLockOrThrow({ profileId, credential, agentDir: state.agentDir() });
      release.resolve();
      const result = await outcome;
      if ("auth" in result) {
        expect(() => result.auth.assertCurrent()).toThrow(/disconnected or replaced/);
      } else {
        expect(result.error).toMatchObject({ code: "MCP_AUTHORIZATION_RETIRED" });
      }
    });
  },
);

it.each(["closure", "reconnect"] as const)(
  "does not claim a new native refresh after %s while waiting on the profile lock",
  async (revocation) => {
    await withRequestFixture(async ({ state, credential, controller, authState, refresh }) => {
      await controller.initializeAuthProfile();
      vi.setSystemTime(credential.expires + 1);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const withLock = profileLock.withOAuthProfileLock;
      vi.spyOn(profileLock, "withOAuthProfileLock").mockImplementationOnce(
        async (key, operation, options) => {
          entered.resolve();
          await release.promise;
          return withLock(key, operation, options);
        },
      );
      const capability = getProviderRequestAuth(authState.models.effective);
      if (!capability) {
        throw new Error("Missing request auth");
      }
      const pending = capability.resolve({});
      const rejected = expect(pending).rejects.toThrow(
        revocation === "closure" ? /closed/ : /disconnected or replaced/,
      );
      await entered.promise;
      if (revocation === "closure") {
        controller.stopRuntimeAuthRefreshTimer();
      } else {
        await upsertAuthProfileWithLockOrThrow({
          profileId,
          credential,
          agentDir: state.agentDir(),
        });
      }
      release.resolve();
      await rejected;
      expect(refresh).not.toHaveBeenCalled();
      expect(readAuthProfileStoreForTest(state.agentDir()).profiles[profileId]).toEqual(credential);
    });
  },
);

it("settles an already claimed native refresh after request closure without returning its bearer", async () => {
  await withRequestFixture(async ({ state, credential, controller, authState, refresh }) => {
    await controller.initializeAuthProfile();
    vi.setSystemTime(credential.expires + 1);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    refresh.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        ...credential,
        access: "settled-access",
        refresh: "settled-refresh",
        expires: Date.now() + 3_600_000,
      };
    });
    const capability = getProviderRequestAuth(authState.models.effective);
    if (!capability) {
      throw new Error("Missing request auth");
    }
    const pending = capability.resolve({});
    const rejected = expect(pending).rejects.toThrow(/closed/);
    await entered.promise;
    controller.stopRuntimeAuthRefreshTimer();
    release.resolve();
    await rejected;
    expect(refresh).toHaveBeenCalledOnce();
    expect(readAuthProfileStoreForTest(state.agentDir()).profiles[profileId]).toMatchObject({
      access: "settled-access",
      refresh: "settled-refresh",
    });
  });
});
