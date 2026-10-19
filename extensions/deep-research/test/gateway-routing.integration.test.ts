import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../../src/agents/admitted-run-context.js";
import { createCodingToolsGatewayCaller } from "../../../src/agents/agent-tools.caller.js";
import { prepareConversationCapabilityProfile } from "../../../src/agents/conversation-capability-profile.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../src/agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../../src/config/config.js";
import {
  upsertSessionEntryCore,
  patchSessionEntryCore,
} from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../../../src/gateway/auth-policy.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../../src/gateway/methods/registry.js";
import { resolveGatewayOperatorAccessAuthority } from "../../../src/gateway/operator-access-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../../src/gateway/operator-run-authority.js";
import { createDirectChatContext } from "../../../src/gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../../src/gateway/server-methods.js";
import { toolsInvokeHandlers } from "../../../src/gateway/server-methods/tools-invoke.js";
import { createOperatorClient } from "../../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { loadGatewayPlugins } from "../../../src/gateway/server-plugins.js";
import { bindSessionRowProjection } from "../../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../src/gateway/session-row-projection.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "../../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeCapabilityLease } from "../../../src/plugins/capability-lease.js";
import * as pluginLoader from "../../../src/plugins/loader.js";
import { clearPluginLoaderCache } from "../../../src/plugins/loader.test-fixtures.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginServiceSessionWork } from "../../../src/plugins/service-session-work.js";
import type { PluginServiceSessionWorkContextV1 } from "../../../src/plugins/service-session-work.types.js";
import { bindPluginToolCallbacks } from "../../../src/plugins/tool-factory-runtime.js";
import { setPluginToolMeta } from "../../../src/plugins/tool-metadata.js";
import { drainGlobalSingletonLifecycleState } from "../../../src/shared/global-singleton.js";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";

// Drain global owners only after withOpenClawTestState closes scoped writers/leases.
afterEach(() => drainGlobalSingletonLifecycleState());

it.each(["policy", "router-refusal", "host-abort"] as const)(
  "fences the real research tool-to-provider route: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();
      // Keep real Gateway runtime, registration and authority; select current source
      // with the native loader option instead of a previous build's plugin artifacts.
      const loadSource = pluginLoader.loadOpenClawPluginsAsync;
      const sourceLoader = vi
        .spyOn(pluginLoader, "loadOpenClawPluginsAsync")
        .mockImplementation((options) =>
          loadSource({ ...options, preferBuiltPluginArtifacts: false }),
        );
      const sessionKey = "agent:main:dashboard:research-route";
      const sessionId = "research-route-generation";
      const storePath = state.path("sessions.json");
      let cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        session: { store: storePath },
        plugins: {
          allow: ["deep-research", "google"],
          entries: {
            "deep-research": { enabled: true },
            google: {
              enabled: true,
              config: { research: { enabled: true, profileId: "google:fixture" } },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const client = createOperatorClient({
        profileName: "research-owner",
        scopes: ["operator.write"],
      });
      assert.ok(client.authenticatedUserProfile);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId,
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile.profileId,
          },
        },
      );
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
        () => projection,
      );
      context.resolveGatewayContext = () => context;
      const source = new AbortController();
      const captured = await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
      });
      assert.ok(captured);
      const prepared = prepareSystemAgentRunAdmission(
        cfg,
        "research-route-run",
        "main",
        "research-route-test",
        undefined,
        captured.authority,
      );
      const admitted = await prepared.admit("embedded");
      bindGatewayContextResolver(admitted, () => context);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey,
        approvalSignals: [source.signal],
      });
      assert.ok(caller);
      const scheduler = createTestPluginServiceScheduler();
      let loaded: Awaited<ReturnType<typeof loadGatewayPlugins>> | undefined;
      let stopService: (() => Promise<void>) | undefined;
      let releaseAcceptedStart: (() => void) | undefined;
      let acceptedHandlerSettlement: Promise<void> | undefined;
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected research activation network request"));
      try {
        loaded = await loadGatewayPlugins({
          cfg,
          autoEnabledReasons: {},
          baseMethods: [],
          pluginIds: ["deep-research", "google"],
          workspaceDir: state.workspaceDir,
          loadIntent: "startup",
          resolveGatewayContext: () => context,
          env: {
            ...process.env,
            OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../..", import.meta.url)),
          },
        });
        const registry = loaded.pluginRegistry;
        setActivePluginRegistry(registry);
        const descriptor = registry.gatewayMethodDescriptors.find(
          (item) => item.name === "google.research.v1",
        );
        assert.ok(descriptor);
        const providerHandler = registry.gatewayHandlers["google.research.v1"];
        assert.ok(providerHandler);
        let denyAfterDescribe = false;
        const startEntered = Promise.withResolvers<AbortSignal | undefined>();
        const releaseReceipt = Promise.withResolvers<void>();
        const startSettled = Promise.withResolvers<void>();
        releaseAcceptedStart = releaseReceipt.resolve;
        const handler = vi.fn(async (options: Parameters<typeof providerHandler>[0]) => {
          const request = options.params.request;
          const action =
            request && typeof request === "object" && "action" in request
              ? request.action
              : undefined;
          if (action === "start" && scenario !== "policy") {
            // Simulate remote acceptance, but retain the real host dispatcher and signal.
            // Provider HTTP/auth contracts are exercised separately by Google's fixtures.
            acceptedHandlerSettlement = startSettled.promise;
            startEntered.resolve(options.signal);
            if (scenario === "host-abort") {
              await releaseReceipt.promise;
            }
            try {
              options.respond(true, {
                version: 1,
                ok: true,
                value: {
                  state: "completed",
                  handle: { interactionId: "accepted-route-fixture", profileId: "google:fixture" },
                  report: "A retained provider report.",
                  citations: [],
                },
              });
            } finally {
              startSettled.resolve();
            }
            return;
          }
          if (action === "describe" && denyAfterDescribe) {
            return providerHandler({
              ...options,
              respond: (...response) => {
                cfg = { ...cfg, tools: { deny: ["deep_research"] } };
                setRuntimeConfigSnapshot(cfg);
                options.respond(...response);
              },
            });
          }
          return providerHandler(options);
        });
        context.getGatewayMethodRegistry = () =>
          createGatewayMethodRegistry(
            registry.gatewayMethodDescriptors.map((item) =>
              item === descriptor ? { ...item, handler } : item,
            ),
            registry,
          );
        const registration = registry.tools.find((entry) => entry.pluginId === "deep-research");
        const service = registry.services.find(
          (entry) => entry.pluginId === "deep-research",
        )?.service;
        assert.ok(registration && service?.apiVersion === 3);
        const serviceContext = {
          sessionWork: createPluginServiceSessionWork({
            pluginId: "deep-research",
            serviceId: "deep-research-jobs",
            registry,
            lease: createPluginRuntimeCapabilityLease("research-test-service"),
            signal: scheduler.signal,
            isStopping: () => scheduler.signal.aborted,
            resolveGatewayContext: () => context,
          }),
          scheduler,
          config: cfg,
          stateDir: state.stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        };
        stopService = async () => {
          await service.stop?.(serviceContext);
        };
        await service.start(serviceContext);
        const created = registration.factory({
          config: cfg,
          agentId: "main",
          sessionKey,
          sessionId,
          assertInvocationCurrent: () => source.signal.throwIfAborted(),
        });
        assert.ok(created && !Array.isArray(created));
        setPluginToolMeta(created, { pluginId: "deep-research", optional: registration.optional });
        const bound = bindPluginToolCallbacks(registration, registry, created);
        const wrap = createCodingToolsGatewayCaller({
          options: { config: cfg, agentId: "main", sessionKey },
          agentId: "main",
          sessionKey,
          capabilityProfile: await prepareConversationCapabilityProfile({
            config: cfg,
            agentId: "main",
            sessionKey,
            sessionId,
          }),
          tools: [bound],
        });
        const tool = wrap(bound);
        const invoke = () =>
          withGatewayToolCallerIdentity(caller, () =>
            tool.execute("capabilities", { action: "capabilities" }),
          );
        const allowed = await invoke();
        expect(allowed.details).toMatchObject({
          managed: {
            version: 1,
            ok: true,
            value: { kind: "managed-research", provider: "google" },
          },
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0]?.[0].client?.internal?.operatorRunAuthority?.source).toBe(
          captured.authority.source,
        );
        expect(handler.mock.calls[0]?.[0].sessionAccessAuthority?.target).toMatchObject({
          agentId: "main",
          sessionKey,
          sessionId,
        });
        const startInput = {
          action: "start",
          idempotencyKey: "route-owned-request",
          request: { question: "Research the river", engine: "google" },
        };
        const countStarts = () =>
          handler.mock.calls.filter(([options]) => {
            const request = options.params.request;
            return (
              request &&
              typeof request === "object" &&
              "action" in request &&
              request.action === "start"
            );
          }).length;
        if (scenario === "router-refusal") {
          denyAfterDescribe = true;
          await expect(
            withGatewayToolCallerIdentity(caller, () => tool.execute("start", startInput)),
          ).rejects.toThrow("Session access is refreshing");
          expect(countStarts()).toBe(0);
          cfg = { ...cfg, tools: { deny: [] } };
          setRuntimeConfigSnapshot(cfg);
          await projection.ensureMaterialized();
          denyAfterDescribe = false;
          // A new invocation may inspect the accepted non-dispatched operation;
          // the revoked invocation cannot return it using a retired borrow.
          const refused = await withGatewayToolCallerIdentity(caller, () =>
            tool.execute("retry", startInput),
          );
          expect(refused.details).toMatchObject({ state: "queued" });
          expect(countStarts()).toBe(0);
          const details = refused.details;
          assert.ok(
            details &&
              typeof details === "object" &&
              "jobId" in details &&
              typeof details.jobId === "string",
          );
          const resumed = await withGatewayToolCallerIdentity(caller, () =>
            tool.execute("resume", { action: "resume", jobId: details.jobId }),
          );
          expect(resumed.details).toMatchObject({ state: "completed" });
          expect(countStarts()).toBe(1);
          expect(network).not.toHaveBeenCalled();
          return;
        }
        if (scenario === "host-abort") {
          const parent = new AbortController();
          const running = withPluginRuntimeGatewayRequestScope(
            { signal: parent.signal, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(caller, () =>
                tool.execute("start", startInput, parent.signal),
              ),
          );
          const providerSignal = await Promise.race([
            startEntered.promise,
            running.then(() => {
              throw new Error("Start ended before simulated provider acceptance");
            }),
          ]);
          assert.ok(providerSignal);
          const rejected = expect(running).rejects.toThrow("parent host stopped");
          parent.abort(new Error("parent host stopped"));
          expect(providerSignal.aborted).toBe(true);
          await rejected;
          releaseReceipt.resolve();
          await startSettled.promise;
          const retry = await withGatewayToolCallerIdentity(caller, () =>
            tool.execute("retry", startInput),
          );
          expect(retry.details).toMatchObject({ state: "indeterminate" });
          expect(JSON.stringify(retry.details)).not.toContain("A retained provider report.");
          expect(countStarts()).toBe(1);
          expect(network).not.toHaveBeenCalled();
          return;
        }
        // The already-built tool retains its admitted policy. Current resource policy
        // must still deny the cross-plugin RPC before the provider handler runs.
        cfg = { ...cfg, tools: { deny: ["deep_research"] } };
        setRuntimeConfigSnapshot(cfg);
        await projection.ensureMaterialized();
        const denied = await invoke();
        expect(denied.details).toMatchObject({ managed: { available: false } });
        expect(handler).toHaveBeenCalledOnce();
        expect(network).not.toHaveBeenCalled();
      } finally {
        releaseAcceptedStart?.();
        await acceptedHandlerSettlement;
        await stopService?.();
        await scheduler.stop();
        loaded?.retireGatewayRuntimeBindings();
        prepared.close();
        captured.release();
        projection.dispose();
        if (loaded) {
          await disposePluginRegistryInstances(loaded.pluginRegistry);
        }
        network.mockRestore();
        sourceLoader.mockRestore();
        resetPluginRuntimeStateForTest();
        clearPluginLoaderCache();
      }
    });
  },
);

it("admits browser research through the real Gateway session gate, recovers acceptance, and denies cross-session/reset reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    clearPluginLoaderCache();
    resetPluginRuntimeStateForTest();
    const loadSource = pluginLoader.loadOpenClawPluginsAsync;
    const sourceLoader = vi
      .spyOn(pluginLoader, "loadOpenClawPluginsAsync")
      .mockImplementation((options) =>
        loadSource({ ...options, preferBuiltPluginArtifacts: false }),
      );
    const sessionKey = "agent:main:dashboard:research-ui";
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      session: { store: storePath },
      plugins: {
        allow: ["deep-research", "google"],
        entries: {
          "deep-research": { enabled: true },
          google: {
            enabled: true,
            config: { research: { enabled: true, profileId: "google:fixture" } },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const client = createOperatorClient({
      profileName: "research-ui-owner",
      scopes: ["operator.read", "operator.write"],
    });
    assert.ok(client.authenticatedUserProfile);
    client.internal = {
      authenticatedOperator: true,
      operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(
        client.authenticatedUserProfile.profileId,
        cfg,
      ),
    };
    client.authPolicy = captureGatewayAuthPolicy(cfg, { role: "operator", authMethod: "token" });
    client.connect.client.id = "openclaw-control-ui";
    client.connect.client.mode = "ui";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "ui-incarnation",
      lifecycleRevision: "original-incarnation",
      updatedAt: 1,
      createdActor: {
        type: "human",
        source: "profile",
        id: client.authenticatedUserProfile.profileId,
      },
    });
    const foreignKey = "agent:main:dashboard:private-research";
    await upsertSessionEntryCore(
      { ...scope, sessionKey: foreignKey },
      {
        sessionId: "foreign-incarnation",
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      },
    );
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
      () => projection,
    );
    context.resolveGatewayContext = () => context;
    const clock = createGatewaySchedulerClock(Date.now());
    let scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    let loaded: Awaited<ReturnType<typeof loadGatewayPlugins>> | undefined;
    let stopService: (() => Promise<void>) | undefined;
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected external request"));
    try {
      loaded = await loadGatewayPlugins({
        cfg,
        autoEnabledReasons: {},
        baseMethods: [],
        pluginIds: ["deep-research", "google"],
        workspaceDir: state.workspaceDir,
        loadIntent: "startup",
        resolveGatewayContext: () => context,
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../..", import.meta.url)),
        },
      });
      const registry = loaded.pluginRegistry;
      setActivePluginRegistry(registry);
      let pauseDiscovery = true;
      const provider = vi.fn<NonNullable<(typeof registry.gatewayHandlers)[string]>>(
        async (options) => {
          const request = options.params.request;
          assert.ok(request && typeof request === "object" && "action" in request);
          if (request.action === "describe" && pauseDiscovery) {
            pauseDiscovery = false;
            options.respond(true, {
              version: 1,
              ok: false,
              state: "blocked",
              retryAfterMs: 5000,
              reason: "Research temporarily unavailable",
            });
            return;
          }
          if (request.action === "describe") {
            options.respond(true, {
              version: 1,
              ok: true,
              value: {
                version: 1,
                kind: "managed-research",
                provider: "google",
                agent: "fixture",
                authModes: ["api-key"],
                citationEvidence: "provider-attributed",
                storageRequired: true,
                hardBudgets: { model: false, search: false, tokens: false },
                idempotentStart: false,
              },
            });
          } else {
            options.respond(true, {
              version: 1,
              ok: true,
              value: {
                state: "completed",
                handle: { interactionId: "ui-accepted", profileId: "google:fixture" },
                report: "Retained browser-started report",
                citations: [],
              },
            });
          }
        },
      );
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry(
          [
            ...createCoreGatewayMethodDescriptors(toolsInvokeHandlers),
            ...registry.gatewayMethodDescriptors.map((item) =>
              item.name === "google.research.v1" ? { ...item, handler: provider } : item,
            ),
          ],
          registry,
        );
      const service = registry.services.find(
        (entry) => entry.pluginId === "deep-research",
      )?.service;
      assert.ok(service?.apiVersion === 3);
      let currentSessionWork: ReturnType<typeof createPluginServiceSessionWork> | undefined;
      const startService = async () => {
        const serviceContext = {
          scheduler,
          config: cfg,
          stateDir: state.stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          sessionWork: createPluginServiceSessionWork({
            pluginId: "deep-research",
            serviceId: "deep-research-jobs",
            registry,
            lease: createPluginRuntimeCapabilityLease("research-ui-service"),
            signal: scheduler.signal,
            isStopping: () => scheduler.signal.aborted,
            resolveGatewayContext: () => context,
          }),
        };
        currentSessionWork = serviceContext.sessionWork;
        stopService = async () => {
          await service.stop?.(serviceContext);
        };
        await service.start(serviceContext);
      };
      await startService();
      const invoke = async (action: string, params: Record<string, unknown> = {}) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "ui-request",
            method: `deep-research.view.v1.${action}`,
            params: { sessionKey, agentId: "main", ...params },
          },
          client,
          respond,
          context,
          methodRegistry: context.getGatewayMethodRegistry!(),
          isWebchatConnect: () => true,
        });
        return respond.mock.calls.at(-1)!;
      };
      const invokeTool = async (action: string, args: Record<string, unknown>) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "model-tool-request",
            method: "tools.invoke",
            params: {
              name: "deep_research",
              args: { action, ...args },
              sessionKey,
              agentId: "main",
            },
          },
          client,
          respond,
          context,
          methodRegistry: context.getGatewayMethodRegistry!(),
          isWebchatConnect: () => true,
        });
        const response = respond.mock.calls.at(-1)!;
        expect(response[0], JSON.stringify(response)).toBe(true);
        return response[1];
      };
      const input = {
        incarnation: (await invoke("list"))[1].incarnation,
        idempotencyKey: "ui-durable",
        request: { question: "Browser-started evidence", engine: "google" },
      };
      const starts = await Promise.all([invoke("start", input), invoke("start", input)]);
      expect(starts[0]?.[0], JSON.stringify(starts[0])).toBe(true);
      expect(starts[1]?.[0], JSON.stringify(starts[1])).toBe(true);
      expect(starts[0][1].job.jobId).toBe(starts[1][1].job.jobId);
      expect(starts[0][1].job.state).toBe("queued");
      expect(provider).not.toHaveBeenCalled();
      const jobId = starts[0][1].job.jobId;
      await stopService!();
      scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      await startService();
      await clock.advanceBy(1000);
      const paused = await invoke("read", { jobId });
      expect(paused[1].job.state).toBe("paused");
      expect(paused[1].job.actions).toContain("resume");
      expect(provider).toHaveBeenCalledTimes(1);
      // Drop only the local scheduler. The accepted job and durable wake survive.
      await stopService!();
      scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      const scheduled = vi.spyOn(scheduler, "schedule");
      await startService();
      for (const result of scheduled.mock.results) {
        if (result.type === "return") {
          result.value.cancel();
        }
      }
      scheduled.mockRestore();
      const resumed = await invoke("resume", { jobId, incarnation: input.incarnation });
      expect(resumed[0], JSON.stringify(resumed)).toBe(true);
      await clock.advanceBy(5000);
      const read = await invoke("read", { jobId });
      expect(read[0], JSON.stringify(read)).toBe(true);
      expect(read[1].job.report).toBe("Retained browser-started report");
      expect(provider).toHaveBeenCalledTimes(3);
      await invoke("list");
      await invoke("read", { jobId });
      expect(provider).toHaveBeenCalledTimes(3);
      assert.ok(currentSessionWork);
      const liveWork = currentSessionWork;
      const admit = vi.spyOn(liveWork, "admit");
      const withCurrent = liveWork.withCurrent;
      let readBorrow: PluginServiceSessionWorkContextV1 | undefined;
      let readError: unknown;
      liveWork.withCurrent = async (target, work) => {
        try {
          return await withCurrent(target, (current) => {
            readBorrow = current;
            return work(current);
          });
        } catch (error) {
          readError = error;
          throw error;
        }
      };
      const modelRead = await invokeTool("result", { jobId });
      liveWork.withCurrent = withCurrent;
      expect(
        modelRead,
        readError instanceof Error ? readError.stack : JSON.stringify(modelRead),
      ).toMatchObject({
        ok: true,
        output: { details: { result: { report: "Retained browser-started report" } } },
      });
      expect(admit).not.toHaveBeenCalled();
      admit.mockRestore();
      expect(readBorrow?.target).toMatchObject({
        sessionId: "ui-incarnation",
        lifecycleRevision: "original-incarnation",
      });
      expect(readBorrow?.signal.aborted).toBe(true);
      expect(() => readBorrow?.assertCurrent()).toThrow("Current session work borrow closed");
      const foreign = await invoke("read", { sessionKey: foreignKey, jobId });
      expect(foreign[0]).toBe(false);
      expect(JSON.stringify(foreign)).not.toContain("Retained browser-started report");
      pauseDiscovery = true;
      const modelInput = {
        idempotencyKey: "model-lifecycle-retry",
        request: { question: "Model-started lifecycle work", engine: "google" },
      };
      const modelStart = await invokeTool("start", modelInput);
      expect(modelStart).toMatchObject({ ok: true, output: { details: { state: "paused" } } });
      const modelJobId = modelStart.output.details.jobId;
      // A standalone tool request cannot fabricate an admitted agent caller for
      // provider dispatch; its retained start stays inspectable with no effect.
      expect(modelStart.output.details.progress).toContain("Recovery deferred:");
      expect(provider).toHaveBeenCalledTimes(3);
      const pending = await invoke("start", { ...input, idempotencyKey: "retired-wake" });
      expect(pending[0], JSON.stringify(pending)).toBe(true);
      const pausedJobId = pending[1].job.jobId;
      await clock.advanceBy(1000);
      expect((await invoke("read", { jobId: pausedJobId }))[1].job.state).toBe("paused");
      expect(provider).toHaveBeenCalledTimes(4);
      const replaced = await patchSessionEntryCore(scope, () => ({
        // Replacing only the lifecycle must fence views even when sessionId is retained.
        lifecycleRevision: "replacement-incarnation",
        updatedAt: Date.now(),
      }));
      expect(replaced).toMatchObject({
        sessionId: "ui-incarnation",
        lifecycleRevision: "replacement-incarnation",
      });
      await projection.ensureMaterialized();
      expect((await invoke("read", { jobId }))[0]).toBe(false);
      const replacedList = await invoke("list");
      expect(replacedList[1].jobs).toEqual([]);
      expect(replacedList[1].incarnation).not.toBe(starts[0][1].incarnation);
      const staleStart = await invoke("start", input);
      expect(staleStart[0]).toBe(false);
      expect(staleStart[2].details.code).toBe("RESEARCH_START_REJECTED");
      expect((await invoke("list"))[1].jobs).toEqual([]);
      // The same real model-tool boundary must fence every sibling action, not only views.
      for (const retiredJobId of [jobId, pausedJobId, modelJobId]) {
        for (const action of ["result", "status", "resume", "cancel"]) {
          const retired = await invokeTool(action, { jobId: retiredJobId });
          expect(retired, action).toMatchObject({ ok: false });
          expect(JSON.stringify(retired)).not.toContain("Retained browser-started report");
        }
        for (const action of ["resume", "cancel"]) {
          expect(
            (
              await invoke(action, {
                jobId: retiredJobId,
                incarnation: replacedList[1].incarnation,
              })
            )[0],
          ).toBe(false);
        }
      }
      expect(await invokeTool("start", modelInput)).toMatchObject({ ok: false });
      expect(provider).toHaveBeenCalledTimes(4);
      // A new live incarnation can start and cancel its own job, with no provider cancellation.
      pauseDiscovery = true;
      const currentStart = await invoke("start", {
        ...input,
        incarnation: replacedList[1].incarnation,
        idempotencyKey: "current-lifecycle-work",
      });
      expect(currentStart[0], JSON.stringify(currentStart)).toBe(true);
      const currentJobId = currentStart[1].job.jobId;
      await clock.advanceBy(1000);
      expect(await invokeTool("status", { jobId: currentJobId })).toMatchObject({
        ok: true,
        output: { details: { state: "paused" } },
      });
      expect(await invokeTool("cancel", { jobId: currentJobId })).toMatchObject({
        ok: true,
        output: { details: { state: "cancelled" } },
      });
      expect((await invoke("read", { jobId: currentJobId }))[1].job.state).toBe("cancelled");
      expect(provider).toHaveBeenCalledTimes(5);
      await stopService!();
      scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
      await startService();
      await clock.advanceBy(10_000);
      // Retained old wakes cannot restore their retired source, even with the UUID unchanged.
      expect(provider).toHaveBeenCalledTimes(5);
      expect((await invoke("list"))[1].jobs.map((job: { jobId: string }) => job.jobId)).toEqual([
        currentJobId,
      ]);
      const replacement = await patchSessionEntryCore(scope, () => ({
        sessionId: "ui-reset-incarnation",
        lifecycleRevision: "reset",
        updatedAt: Date.now(),
      }));
      expect(replacement).toMatchObject({
        sessionId: "ui-reset-incarnation",
        lifecycleRevision: "reset",
      });
      await projection.ensureMaterialized();
      const reset = await invoke("read", { jobId });
      expect(reset[0]).toBe(false);
      expect(JSON.stringify(reset)).not.toContain("Retained browser-started report");
      expect(network).not.toHaveBeenCalled();
    } finally {
      await stopService?.();
      await scheduler.stop();
      projection.dispose();
      if (loaded) {
        await disposePluginRegistryInstances(loaded.pluginRegistry);
      }
      sourceLoader.mockRestore();
      network.mockRestore();
      resetPluginRuntimeStateForTest();
    }
  });
}, 60_000);
