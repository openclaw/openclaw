import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../../src/agents/admitted-run-context.js";
import { createCodingToolsGatewayCaller } from "../../../src/agents/agent-tools.caller.js";
import { prepareConversationCapabilityProfile } from "../../../src/agents/conversation-capability-profile.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../../src/agents/prepared-model-runtime.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../src/agents/tools/gateway-caller-context.js";
import { createWebFetchTool, createWebSearchTool } from "../../../src/agents/tools/web-tools.js";
import { setRuntimeConfigSnapshot } from "../../../src/config/config.js";
import {
  upsertSessionEntryCore,
  resetSessionEntryLifecycle,
  deleteSessionEntryLifecycle,
} from "../../../src/config/sessions/session-accessor.js";
import { captureGatewayAuthPolicy } from "../../../src/gateway/auth-policy.js";
import {
  createGatewayMethodRegistry,
  createCoreGatewayMethodDescriptors,
} from "../../../src/gateway/methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../../../src/gateway/operator-run-authority.js";
import { createDirectChatContext } from "../../../src/gateway/server-chat.agent-events.test-helpers.js";
import { toolsInvokeHandlers } from "../../../src/gateway/server-methods/tools-invoke.js";
import { createOperatorClient } from "../../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { loadGatewayPlugins } from "../../../src/gateway/server-plugins.js";
import { bindSessionRowProjection } from "../../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../src/gateway/session-row-projection.js";
import { createPluginStateKeyedStoreV2ForTests } from "../../../src/plugin-sdk/plugin-state-test-runtime.js";
import * as stateWriter from "../../../src/plugin-state/plugin-state-worker-client.js";
import * as pluginLoader from "../../../src/plugins/loader.js";
import { clearPluginLoaderCache } from "../../../src/plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../../../src/plugins/plugin-instance-scope.js";
import {
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../src/plugins/runtime/gateway-request-scope.js";
import * as serviceAutomation from "../../../src/plugins/service-automation-capabilities.js";
import type { PluginServiceSessionWorkContextV1 } from "../../../src/plugins/service-session-work.types.js";
import { startPluginServices, type PluginServicesHandle } from "../../../src/plugins/services.js";
import { bindPluginToolCallbacks } from "../../../src/plugins/tool-factory-runtime.js";
import { sessionChanges } from "../../../src/sessions/session-row-changes.js";
import { drainGlobalSingletonLifecycleState } from "../../../src/shared/global-singleton.js";
import { jsonResponse, requestUrl } from "../../../src/test-helpers/http.js";
import { mockPinnedHostnameResolution } from "../../../src/test-helpers/ssrf.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../../src/test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import {
  interruptPendingResearchCapture,
  prepareResearchRecoveryConfig,
  probeUnadmittedRuntimeSiblings,
} from "./gateway-recovery.test-support.js";

// The scoped fixture joins writers/agent leases before shared singleton drainage.
afterEach(() => drainGlobalSingletonLifecycleState());

type StoredJob = {
  id: string;
  state: string;
  recovery?: string;
  nextWakeAt?: number;
  deadlineAt?: number;
  publicationId?: string;
  handle?: unknown;
  result?: { report?: string; gaps?: string[] };
};

it.each([
  "restart",
  "public-context",
  "stop-before-wake-admission",
  "admission-snapshot",
  "duplicate-admission-source",
  "refresh-before-work",
  "queued-start-refresh",
  "queued-before-dispatch-refresh",
  "queued-during-dispatch-refresh",
  "portable-refresh",
  "pending-cancel",
  "cancel-late-completion",
  "ambiguous",
  "reset-after-await",
  "delete-after-await",
  "provider-reload-after-await",
  "portable-documents",
  "portable-agent-owner",
  "portable-foreground-agent-owner",
  "portable-web",
  "portable-expired",
] as const)(
  "recovers through the actual service/scheduler/provider boundary: %s",
  async (scenario) => {
    const portable = scenario.startsWith("portable-");
    const web = scenario === "portable-web";
    const expired = scenario === "portable-expired";
    const multiAgent = scenario.endsWith("agent-owner");
    const agentId = multiAgent ? "research" : "main";
    const queued = scenario.startsWith("queued-") || scenario === "portable-agent-owner";
    const duplicate = scenario === "duplicate-admission-source";
    const refresh = scenario === "refresh-before-work" || scenario === "portable-refresh";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      clearPluginLoaderCache();
      resetPluginRuntimeStateForTest();
      // Keep real Gateway runtime, registration and authority; select current source
      // with the native loader option instead of a previous build's plugin artifacts.
      const loadSource = pluginLoader.loadOpenClawPluginsAsync;
      const sourceLoader = vi
        .spyOn(pluginLoader, "loadOpenClawPluginsAsync")
        .mockImplementation((options) =>
          loadSource({ ...options, preferBuiltPluginArtifacts: false, pluginSdkResolution: "src" }),
        );
      const sessionKey = `agent:${agentId}:dashboard:research-recovery`;
      const sessionId = "accepted-research-generation";
      const storePath = state.path("sessions.json");
      const cfg = await prepareResearchRecoveryConfig(state, {
        storePath,
        agentId,
        portable,
        web,
        expired,
        documentsOnly: scenario === "portable-documents",
      });
      setRuntimeConfigSnapshot(cfg);
      const client = createOperatorClient({
        profileName: "research-recovery-owner",
        scopes: ["operator.admin"],
      });
      assert.ok(client.authenticatedUserProfile);
      client.internal = { authenticatedOperator: true, controlUiAdmin: true };
      client.authPolicy = captureGatewayAuthPolicy(cfg, { role: "operator", authMethod: "token" });
      const entry = {
        sessionId,
        lifecycleRevision: "accepted-lifecycle",
        ...(duplicate ? { visibility: "shared" as const } : {}),
        updatedAt: 1,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: client.authenticatedUserProfile.profileId,
        },
      };
      await upsertSessionEntryCore({ agentId, sessionKey, storePath }, entry);
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
        () => projection,
      );
      context.resolveGatewayContext = () => context;
      const captured = await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: null,
      });
      assert.ok(captured?.authority.recoverySnapshot);
      const prepared = prepareSystemAgentRunAdmission(
        cfg,
        "research-recovery-run",
        agentId,
        "research-recovery-test",
        undefined,
        captured.authority,
      );
      const admitted = await prepared.admit("embedded");
      bindGatewayContextResolver(admitted, () => context);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId,
        sessionKey,
      });
      assert.ok(caller);
      let secondary:
        | { client: typeof client; caller: typeof caller; close: () => void }
        | undefined;
      if (duplicate) {
        const otherClient = createOperatorClient({
          profileName: "research-recovery-other-operator",
          scopes: ["operator.admin"],
        });
        otherClient.internal = { authenticatedOperator: true, controlUiAdmin: true };
        otherClient.authPolicy = captureGatewayAuthPolicy(cfg, {
          role: "operator",
          authMethod: "token",
        });
        const otherCaptured = await captureGatewayOperatorRunAuthority({
          client: otherClient,
          context,
          sourceAuthority: null,
        });
        assert.ok(otherCaptured?.authority.recoverySnapshot);
        expect(otherCaptured.authority.recoverySnapshot.profileId).not.toBe(
          captured.authority.recoverySnapshot.profileId,
        );
        const otherPrepared = prepareSystemAgentRunAdmission(
          cfg,
          "research-recovery-other-run",
          agentId,
          "research-recovery-test",
          undefined,
          otherCaptured.authority,
        );
        const otherAdmitted = await otherPrepared.admit("embedded");
        bindGatewayContextResolver(otherAdmitted, () => context);
        const otherCaller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: otherAdmitted,
          agentId,
          sessionKey,
        });
        assert.ok(otherCaller);
        secondary = {
          client: otherClient,
          caller: otherCaller,
          close: () => {
            otherPrepared.close();
            otherCaptured.release();
          },
        };
      }
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const lookup = createPluginStateKeyedStoreV2ForTests<StoredJob>(
        "deep-research",
        {
          namespace: `research-jobs-v1-${createHash("sha256").update(`${agentId}\n${sessionKey}\n${sessionId}`).digest("hex")}`,
          maxEntries: 32,
          overflowPolicy: "reject-new",
          env: state.env,
        },
        { assertCurrent() {} },
      );
      let capabilitySpy: { mockRestore: () => void } | undefined;
      let interruptedAdmissions = 0;
      let services: PluginServicesHandle | undefined;
      let stopBeforeAdmission = scenario === "stop-before-wake-admission";
      const wakeAdmission = Promise.withResolvers<AbortSignal>();
      const releaseWakeAdmission = Promise.withResolvers<void>();
      let siblingResults: PromiseSettledResult<unknown>[] = [];
      let queuedStop: ReturnType<PluginServicesHandle["stop"]> | undefined;
      const borrowed: PluginServiceSessionWorkContextV1[] = [];
      let loaded: Awaited<ReturnType<typeof loadGatewayPlugins>> | undefined;
      let phase: "foreground" | "recovery" = "foreground";
      let submits = 0;
      let preDispatchRefresh = false;
      const captureSpy =
        scenario === "queued-during-dispatch-refresh"
          ? interruptPendingResearchCapture(
              sessionKey,
              async () =>
                phase === "recovery" && (await lookup.entries())[0]?.value.state === "submitting",
            )
          : undefined;
      let polls = 0;
      let cancels = 0;
      let publications = 0;
      let completions = 0;
      const modelRequests: Array<{ model: string; authOwner: string }> = [];
      let searches = 0;
      let fetches = 0;
      let citationHeads = 0;
      const sourceUrl = "https://example.org/research-recovery-river";
      const sourceText = "The river restoration was completed in 2025.";
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = stateWriter.registerPluginStateInWorker;
      const writeSpy = vi
        .spyOn(stateWriter, "registerPluginStateInWorker")
        .mockImplementation(async (input) => {
          await write(input);
          if (
            input.pluginId === "deep-research" &&
            input.namespace.startsWith("research-jobs-v1-")
          ) {
            const value: unknown = JSON.parse(input.valueJson);
            if (
              scenario === "queued-before-dispatch-refresh" &&
              phase === "recovery" &&
              !preDispatchRefresh &&
              value &&
              typeof value === "object" &&
              "state" in value &&
              value.state === "submitting"
            ) {
              preDispatchRefresh = true;
              sessionChanges.emitBatch([{ sessionKey, factsInvalidated: "category" }]);
              const current = borrowed.at(-1);
              assert.ok(current);
              expect(() => current.assertCurrent()).toThrow("refreshing");
            }
            if (value && typeof value === "object" && "publicationId" in value) {
              publications += 1;
            }
          }
        });
      const registerIfAbsent = stateWriter.registerPluginStateIfAbsentInWorker;
      const registerSpy = vi
        .spyOn(stateWriter, "registerPluginStateIfAbsentInWorker")
        .mockImplementation(async (input) => {
          const registered = await registerIfAbsent(input);
          if (
            registered &&
            queued &&
            phase === "foreground" &&
            !queuedStop &&
            input.pluginId === "deep-research" &&
            input.namespace.startsWith("research-jobs-v1-")
          ) {
            const value: unknown = JSON.parse(input.valueJson);
            if (
              value &&
              typeof value === "object" &&
              "state" in value &&
              value.state === "queued"
            ) {
              assert.ok(services);
              queuedStop = services.stop({ strict: true });
            }
          }
          return registered;
        });
      const dns = mockPinnedHostnameResolution();
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const path = requestUrl(url);
        if (portable) {
          if (path.includes(":streamGenerateContent")) {
            completions += 1;
            const body =
              typeof init?.body === "string"
                ? init.body
                : url instanceof Request
                  ? await url.clone().text()
                  : "";
            const headers = new Headers(
              init?.headers ?? (url instanceof Request ? url.headers : undefined),
            );
            const model = new URL(path).pathname.match(/models\/([^/:]+):/)?.[1] ?? "unknown";
            const key = headers.get("x-goog-api-key");
            modelRequests.push({
              model,
              authOwner:
                key === "synthetic-recovery-key"
                  ? "research"
                  : key === "synthetic-wrong-agent-key"
                    ? "main"
                    : "unexpected",
            });
            if (!multiAgent) {
              expect(key).toBe("synthetic-recovery-key");
              expect(model).toBe("gemini-2.5-flash");
            }
            const output = body.includes("Plan research for the request below")
              ? { questions: ["River restoration recovery fixture"] }
              : body.includes("Extract atomic findings")
                ? {
                    findings: [
                      {
                        statement: "The river restoration was completed in 2025.",
                        evidence: [{ sourceId: "S1", quote: sourceText }],
                      },
                    ],
                    gaps: [],
                    queries: [],
                  }
                : {
                    verdicts: [
                      {
                        index: 0,
                        verdict: "supported",
                        reason: "The supplied passage states the completion date.",
                      },
                    ],
                    unanswered: [],
                  };
            return new Response(
              `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: model })}\n\n`,
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          if (path.includes(":generateContent")) {
            searches += 1;
            return jsonResponse({
              candidates: [
                {
                  content: { parts: [{ text: "A report about river restoration." }] },
                  groundingMetadata: {
                    groundingChunks: [{ web: { uri: sourceUrl, title: "River report" } }],
                  },
                },
              ],
            });
          }
          if (path === sourceUrl) {
            const method = init?.method ?? (url instanceof Request ? url.method : "GET");
            if (method === "HEAD") {
              citationHeads += 1;
              return new Response(null, { status: 200 });
            }
            expect(method).toBe("GET");
            fetches += 1;
            return new Response(sourceText, {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }
          throw new Error(`Unexpected portable provider URL: ${path}`);
        }
        const submit = init?.method === "POST" && !path.endsWith("/cancel");
        if (submit) {
          submits += 1;
          if (scenario === "queued-start-refresh" && phase === "recovery") {
            sessionChanges.emitBatch([{ sessionKey, factsInvalidated: "category" }]);
            const current = borrowed.at(-1);
            assert.ok(current);
            expect(() => current.assertCurrent()).toThrow("refreshing");
            expect(current.signal.aborted).toBe(true);
          }
          if (scenario === "ambiguous") {
            entered.resolve();
            await release.promise;
          }
          return jsonResponse({ id: "native-recovery-receipt", status: "in_progress" });
        }
        const cancel = path.endsWith("/cancel");
        if (cancel) {
          cancels += 1;
        } else {
          polls += 1;
        }
        if (phase === "foreground") {
          // End the foreground observation window without timers or new remote work.
          clock.setTime(clock.clock.now() + 2);
          return jsonResponse({ id: "native-recovery-receipt", status: "in_progress" });
        }
        entered.resolve();
        await release.promise;
        if (scenario === "cancel-late-completion" && cancel) {
          return jsonResponse({ error: { message: "Already complete" } }, 409);
        }
        return jsonResponse({
          id: "native-recovery-receipt",
          status: scenario === "pending-cancel" ? "cancelled" : "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "Recovered provider report." }],
            },
          ],
        });
      });
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
        assert.equal(
          registry.services.find((item) => item.pluginId === "deep-research")?.service.apiVersion,
          3,
          "Lifecycle proof must execute current source, never a retained build",
        );
        if (
          scenario === "public-context" ||
          scenario === "stop-before-wake-admission" ||
          scenario === "admission-snapshot" ||
          duplicate ||
          refresh ||
          queued
        ) {
          const createCapabilities = serviceAutomation.createPluginServiceAutomationCapabilities;
          capabilitySpy = vi
            .spyOn(serviceAutomation, "createPluginServiceAutomationCapabilities")
            .mockImplementation((options) => {
              const capabilities = createCapabilities(options);
              if (options.pluginId !== "deep-research") {
                return capabilities;
              }
              return {
                ...capabilities,
                sessionWork: {
                  ...capabilities.sessionWork,
                  admit: async (input) => {
                    const pendingAdmission = capabilities.sessionWork.admit(input);
                    if (scenario === "admission-snapshot") {
                      input.id = "caller-mutated-after-admit";
                    }
                    const accepted = await pendingAdmission;
                    if (duplicate && interruptedAdmissions++ < 2) {
                      expect(accepted.recoverable).toBe(true);
                      // Real host admission commits, then feature registration is
                      // interrupted. Retrying must not substitute another source.
                      throw new Error("Interrupted after durable admission");
                    }
                    return accepted;
                  },
                  run: async (id, work) => {
                    if (stopBeforeAdmission && phase === "recovery") {
                      stopBeforeAdmission = false;
                      wakeAdmission.resolve(options.signal);
                      await releaseWakeAdmission.promise;
                    }
                    return capabilities.sessionWork.run(id, async (current) => {
                      borrowed.push(current);
                      if (scenario === "public-context") {
                        siblingResults = await probeUnadmittedRuntimeSiblings(context, sessionKey);
                      }
                      if (refresh && borrowed.length === 1) {
                        sessionChanges.emitBatch([{ sessionKey, factsInvalidated: "category" }]);
                        expect(
                          projection.sharingTargetState({ agentId, key: sessionKey }).status,
                        ).toBe("pending");
                        let interruption: unknown;
                        try {
                          current.assertCurrent();
                        } catch (error) {
                          interruption = error;
                        }
                        expect(interruption).toBeInstanceOf(Error);
                        await projection.prepareMembership();
                        expect(
                          projection.sharingTargetState({ agentId, key: sessionKey }).status,
                        ).toBe("ready");
                        // This borrow cannot become live again even if facts are ready before catch.
                        expect(current.signal.aborted).toBe(true);
                        expect(() => current.assertCurrent()).toThrow("refreshing");
                        throw interruption;
                      }
                      return work(current);
                    });
                  },
                },
              };
            });
        }
        setActivePluginRegistry(registry);
        context.getGatewayMethodRegistry = () =>
          createGatewayMethodRegistry(
            [
              ...createCoreGatewayMethodDescriptors(toolsInvokeHandlers),
              ...registry.gatewayMethodDescriptors,
            ],
            registry,
          );
        const startServices = async () => {
          services = await startPluginServices({
            registry,
            config: cfg,
            scheduler,
            previous: services,
          });
        };
        await startServices();
        expect(network).not.toHaveBeenCalled();
        const registration = registry.tools.find((item) => item.pluginId === "deep-research");
        assert.ok(registration);
        const created = registration.factory({
          config: cfg,
          agentId,
          sessionKey,
          sessionId,
          assertInvocationCurrent: () => {
            const current = projection.sharingTarget({ agentId, key: sessionKey });
            assert.equal(current?.entry.sessionId, sessionId);
            assert.equal(current?.entry.lifecycleRevision, entry.lifecycleRevision);
          },
        });
        assert.ok(created && !Array.isArray(created));
        const bound = bindPluginToolCallbacks(registration, registry, created);
        const executableTools = [bound];
        if (web) {
          const search = createWebSearchTool({ config: cfg });
          assert.ok(search);
          executableTools.push(search);
        }
        if (web || expired) {
          const fetch = createWebFetchTool({ config: cfg, agentSessionKey: sessionKey });
          assert.ok(fetch);
          executableTools.push(fetch);
        }
        const wrap = createCodingToolsGatewayCaller({
          options: { config: cfg, agentId, sessionKey },
          agentId,
          sessionKey,
          capabilityProfile: await prepareConversationCapabilityProfile({
            config: cfg,
            agentId,
            sessionKey,
            sessionId,
          }),
          tools: executableTools,
        });
        const tool = wrap(bound);
        const invoke = (
          id: string,
          args: unknown,
          onUpdate?: Parameters<typeof tool.execute>[3],
          source = { client, caller },
        ) =>
          withPluginRuntimeGatewayRequestScope(
            {
              client: source.client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              withGatewayToolCallerIdentity(source.caller, () =>
                tool.execute(id, args, undefined, onUpdate),
              ),
          );
        let portableStop: ReturnType<PluginServicesHandle["stop"]> | undefined;
        const startArgs = {
          action: "start",
          idempotencyKey: "durable-recovery",
          request: portable
            ? {
                question: "When was the river restoration completed?",
                engine: "portable",
                sources: web
                  ? { web: true }
                  : {
                      web: false,
                      documents: [{ title: "River report", text: sourceText }],
                      ...(expired ? { urls: [sourceUrl] } : {}),
                    },
                budget: { durationMs: 60_000 },
              }
            : { engine: "google", question: "Research the river" },
        };
        if (duplicate) {
          assert.ok(secondary);
          await expect(invoke("orphan", startArgs)).rejects.toThrow(
            "Interrupted after durable admission",
          );
          // A same-source retry matches the persisted snapshot after JSON roundtrip.
          await expect(invoke("same-source", startArgs)).rejects.toThrow(
            "Interrupted after durable admission",
          );
          expect(await lookup.entries()).toEqual([]);
          expect(submits).toBe(0);
          await expect(invoke("different-source", startArgs, undefined, secondary)).rejects.toThrow(
            "Session work ID belongs to a different accepted operation",
          );
          expect(await lookup.entries()).toEqual([]);
          expect(submits).toBe(0);
          secondary.close();
          secondary = undefined;
        }
        const pending = invoke("start", startArgs, (update) => {
          if (
            portable &&
            !portableStop &&
            update.content.some(
              (part) => part.type === "text" && part.text === "Gathering evidence (round 1)",
            )
          ) {
            assert.ok(services);
            // The observable progress boundary follows the committed plan/fetch
            // receipts and precedes the next paid step. Stop the real service here.
            portableStop = services.stop({ strict: true });
          }
        });
        if (portable && !queued) {
          const interruption = await pending.then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(interruption).toBeInstanceOf(Error);
          assert.ok(
            portableStop,
            `Portable execution must reach the controlled service stop: ${String(interruption)}`,
          );
          await portableStop;
          const job = (await lookup.entries())[0]?.value;
          assert.ok(job);
          expect(job).toMatchObject({ state: "running", recovery: "ready" });
          expect(completions).toBe(1);
          expect(searches).toBe(0);
          expect(citationHeads).toBe(0);
          expect(fetches).toBe(expired ? 1 : 0);
          if (expired) {
            assert.ok(job.deadlineAt);
            clock.setTime(job.deadlineAt + 1);
          }
        } else if (queued) {
          await expect(pending).rejects.toThrow();
          assert.ok(queuedStop);
          await queuedStop;
          expect((await lookup.entries())[0]?.value).toMatchObject({
            state: "queued",
            recovery: "ready",
          });
          expect(submits).toBe(0);
        } else if (scenario === "ambiguous") {
          const rejection = expect(pending).rejects.toThrow();
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Start ended before remote acceptance");
            }),
          ]);
          await services?.stop({ strict: true });
          release.resolve();
          await rejection;
        } else {
          const first = await pending;
          expect(first.details).toMatchObject({ state: "paused" });
          const jobs = await lookup.entries();
          const job = jobs[0]?.value;
          assert.ok(job);
          expect(job).toMatchObject({
            recovery: "ready",
            handle: { interactionId: "native-recovery-receipt" },
          });
          expect(job.nextWakeAt).toBeTypeOf("number");
          if (scenario === "pending-cancel" || scenario === "cancel-late-completion") {
            const cancelled = await invoke("cancel", { action: "cancel", jobId: job.id });
            expect(cancelled.details).toMatchObject({ state: "paused" });
            expect(cancels).toBe(1);
          }
          await services?.stop({ strict: true });
        }
        expect(submits).toBe(portable || queued ? 0 : 1);
        expect(publications).toBe(0);
        prepared.close();
        captured.release();
        phase = "recovery";
        await startServices();
        let waking = clock.advanceBy(6000);
        if (scenario === "stop-before-wake-admission") {
          const signal = await Promise.race([
            wakeAdmission.promise,
            Promise.resolve(waking).then(() => {
              throw new Error("Wake ended before admission gate");
            }),
          ]);
          assert.ok(services);
          const stopping = services.stop({ strict: true });
          expect(signal.aborted).toBe(true);
          releaseWakeAdmission.resolve();
          await waking;
          await stopping;
          expect((await lookup.entries())[0]?.value).toMatchObject({
            state: "paused",
            recovery: "ready",
            handle: { interactionId: "native-recovery-receipt" },
          });
          expect(submits).toBe(1);
          expect(publications).toBe(0);
          await startServices();
          waking = clock.advanceBy(6000);
        }
        if (refresh || (queued && !portable)) {
          await waking;
          const deferred = (await lookup.entries())[0]?.value;
          expect(deferred).toMatchObject({ recovery: "ready", state: "paused" });
          if (queued && scenario !== "queued-start-refresh") {
            expect(preDispatchRefresh || captureSpy?.interrupted).toBe(true);
            expect(deferred?.handle).toBeUndefined();
            expect(submits).toBe(0);
            expect(polls).toBe(0);
          } else if (queued) {
            expect(deferred?.handle).toMatchObject({ interactionId: "native-recovery-receipt" });
            expect(submits).toBe(1);
            expect(polls).toBe(0);
          }
          expect(publications).toBe(0);
          assert.ok(deferred?.nextWakeAt);
          expect(deferred.nextWakeAt - clock.clock.now()).toBeGreaterThanOrEqual(5000);
          waking = clock.advanceBy(deferred.nextWakeAt - clock.clock.now());
        }
        if (!portable && scenario !== "ambiguous") {
          await Promise.race([
            entered.promise,
            Promise.resolve(waking).then(async () => {
              throw new Error(
                `Recovery wake ended before provider invocation: ${JSON.stringify(await lookup.entries())}`,
              );
            }),
          ]);
          // An overlapping host tick may coalesce, but cannot acquire a second job execution.
          const overlap = clock.advanceBy(6000);
          if (scenario === "reset-after-await") {
            await resetSessionEntryLifecycle({
              agentId,
              storePath,
              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              archivePreviousTranscript: false,
              buildNextEntry: () => ({
                ...entry,
                sessionId: "reset-generation",
                lifecycleRevision: "reset-lifecycle",
              }),
            });
            await projection.ensureMaterialized();
          }
          if (scenario === "delete-after-await") {
            await deleteSessionEntryLifecycle({
              agentId,
              storePath,
              target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
              archiveTranscript: false,
              expectedSessionId: sessionId,
            });
            await projection.ensureMaterialized();
          }
          if (scenario === "provider-reload-after-await") {
            // Actual plugin disposal retires the registered provider and its pending HTTP work.
            const google = registry.plugins.find((item) => item.id === "google");
            assert.ok(google);
            // Start disposal before remote completion; do not wait on its in-flight consumer.
            const instance = getPluginInstance(google);
            assert.ok(instance);
            const disposing = instance.dispose();
            release.resolve();
            await disposing;
          } else {
            release.resolve();
          }
          await overlap;
        }
        await waking;
        await expect.poll(async () => (await lookup.entries())[0]?.value.state).not.toBe("running");
        const final = (await lookup.entries())[0]?.value;
        assert.ok(final);
        expect(submits).toBe(portable ? 0 : 1);
        if (scenario === "public-context") {
          expect(siblingResults).toHaveLength(4);
          for (const result of siblingResults) {
            expect(result.status).toBe("rejected");
            if (result.status === "rejected") {
              expect(String(result.reason)).toContain("registered session-tool boundary");
            }
          }
          expect(borrowed).toHaveLength(1);
          const current = borrowed[0];
          assert.ok(current);
          expect(Object.keys(current).toSorted()).toEqual(["assertCurrent", "signal", "target"]);
          expect(Object.isFrozen(current)).toBe(true);
          expect(Object.isFrozen(current.target)).toBe(true);
          expect(Reflect.set(current, "assertCurrent", () => {})).toBe(false);
          expect(Reflect.set(current.target, "sessionKey", "agent:main:foreign-session")).toBe(
            false,
          );
          expect(() => current.assertCurrent()).toThrow();
        }
        if (scenario === "admission-snapshot") {
          expect(borrowed).toHaveLength(1);
        }
        if (portable) {
          if (multiAgent) {
            expect(modelRequests).toEqual(
              Array.from({ length: 3 }, () => ({
                model: "gemini-2.5-pro",
                authOwner: "research",
              })),
            );
          }
          expect(
            final.state,
            JSON.stringify({
              completions,
              searches,
              citationHeads,
              fetches,
              gaps: final.result?.gaps,
            }),
          ).toBe(expired ? "partial" : "completed");
          expect(final.result).toMatchObject({
            engine: "portable",
            status: expired ? "partial" : "completed",
          });
          expect(completions).toBe(expired ? 1 : 3);
          expect(searches).toBe(web ? 1 : 0);
          expect(citationHeads).toBe(web ? 1 : 0);
          expect(fetches).toBe(web || expired ? 1 : 0);
          expect(publications).toBe(1);
          if (!expired) {
            expect(final.result?.report).toContain(sourceText);
          }
          await services?.stop({ strict: true });
          await startServices();
          await clock.advanceBy(60_000);
          expect((await lookup.entries())[0]?.value).toEqual(final);
          expect(completions).toBe(expired ? 1 : 3);
          expect(searches).toBe(web ? 1 : 0);
          expect(citationHeads).toBe(web ? 1 : 0);
          expect(fetches).toBe(web || expired ? 1 : 0);
          expect(publications).toBe(1);
        } else if (scenario === "ambiguous") {
          expect(final.state).toBe("indeterminate");
          expect(polls).toBe(0);
          expect(publications).toBe(0);
        } else if (
          scenario === "reset-after-await" ||
          scenario === "delete-after-await" ||
          scenario === "provider-reload-after-await"
        ) {
          expect(final.result).toBeUndefined();
          expect(publications).toBe(0);
        } else {
          expect(final.state).toBe(scenario === "pending-cancel" ? "cancelled" : "completed");
          expect(publications).toBe(1);
          expect(final.publicationId).toBe(final.id);
          await services?.stop({ strict: true });
          await startServices();
          await clock.advanceBy(60_000);
          expect(submits).toBe(1);
          expect(publications).toBe(1);
          expect((await lookup.entries())[0]?.value).toEqual(final);
        }
      } finally {
        releaseWakeAdmission.resolve();
        release.resolve();
        await services?.stop();
        await scheduler.stop();
        capabilitySpy?.mockRestore();
        captureSpy?.mockRestore();
        loaded?.retireGatewayRuntimeBindings();
        secondary?.close();
        prepared.close();
        captured.release();
        projection.dispose();
        if (loaded) {
          await disposePluginRegistryInstances(loaded.pluginRegistry);
        }
        if (portable) {
          await resetPreparedModelRuntimeSnapshotsForTest();
        }
        network.mockRestore();
        sourceLoader.mockRestore();
        writeSpy.mockRestore();
        registerSpy.mockRestore();
        dns.mockRestore();
        resetPluginRuntimeStateForTest();
        clearPluginLoaderCache();
      }
    });
  },
);
