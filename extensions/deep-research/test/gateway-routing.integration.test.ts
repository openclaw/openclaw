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
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { createGatewayMethodRegistry } from "../../../src/gateway/methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../../../src/gateway/operator-run-authority.js";
import { createDirectChatContext } from "../../../src/gateway/server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { loadGatewayPlugins } from "../../../src/gateway/server-plugins.js";
import { bindSessionRowProjection } from "../../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../src/gateway/session-row-projection.js";
import { createTestPluginServiceScheduler } from "../../../src/plugin-sdk/plugin-test-api.js";
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
          const refused = await withGatewayToolCallerIdentity(caller, () =>
            tool.execute("start", startInput),
          );
          expect(refused.details).toMatchObject({
            state: "paused",
            progress:
              "Recovery deferred: Gateway refused this request before provider dispatch; fresh authority is required.",
          });
          expect(countStarts()).toBe(0);
          const details = refused.details;
          assert.ok(
            details &&
              typeof details === "object" &&
              "jobId" in details &&
              typeof details.jobId === "string",
          );
          cfg = { ...cfg, tools: { deny: [] } };
          setRuntimeConfigSnapshot(cfg);
          await projection.ensureMaterialized();
          denyAfterDescribe = false;
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
