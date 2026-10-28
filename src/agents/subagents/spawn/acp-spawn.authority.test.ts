import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import * as acpManager from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import { SessionActorQueue } from "../../../acp/control-plane/session-actor-queue.js";
import * as runtimeRegistry from "../../../acp/runtime/registry.js";
import type { CliDeps } from "../../../cli/deps.types.js";
import * as configRuntime from "../../../config/config.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import * as sessionEntryWorker from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as gatewayCall from "../../../gateway/call.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { withLocalGatewayRequestScope } from "../../../gateway/local-request-context.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getSessionRowProjection } from "../../../gateway/session-row-projection-access.js";
import * as bindings from "../../../infra/outbound/session-binding-service.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import { loadActivatedBundledPluginPublicSurfaceModule } from "../../../plugin-sdk/facade-runtime.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import * as gatewayScope from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { listSessionStateEventsSince } from "../../../sessions/session-state-events.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import * as admissionContext from "../../admitted-run-context.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import * as gatewayCaller from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as registryPersistence from "../registry/subagent-registry.persistence.test-support.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import * as acpSpawnRuntime from "./acp-spawn-runtime.js";
import { createAcpSpawnSessionBinding } from "./acp-spawn-store.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

// mock-isolation: Authority tests supply their own registry without loading installed plugins.
vi.mock("../../runtime-plugins.js", () => {
  const loadRegistry = vi.fn<typeof loadAgentRuntimePluginRegistryHandle>();
  return {
    loadAgentRuntimePluginRegistryHandle: loadRegistry,
    loadAgentRuntimePluginRegistryHandleAsync: async (...args: Parameters<typeof loadRegistry>) =>
      loadRegistry(...args),
  };
});

const parentSessionKey = "agent:main:main";
const parentScope = { agentId: "main", sessionKey: parentSessionKey };
const parentRunId = "acp-spawn-parent";
const backendId = "spawn-authority-fixture";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeAll(async () => {
  // Prepare the real cleanup graph before the RPC deadline starts; source
  // transformation is not part of the running Gateway's cleanup budget.
  await Promise.all([
    import("../../../gateway/server-methods/sessions-delete.js"),
    import("../../../gateway/server-methods/sessions.runtime.js"),
    import("../../embedded-agent.js"),
    import("../../agent-bundle-mcp-tools.js"),
    import("../../bash-process-registry.js"),
  ]);
});

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-acp-authority-")));
  const configPath = path.join(stateDir, "openclaw.json");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { file: path.join(stateDir, "gateway.log"), audit: { enabled: false } },
      acp: { enabled: true, backend: backendId, allowedAgents: ["fixture"] },
      agents: {
        ownership: "explicit",
        defaults: { workspace: stateDir },
        entries: { main: { workspace: stateDir }, fixture: { workspace: stateDir } },
      },
    }),
  );
  configRuntime.clearConfigCache();
  configRuntime.clearRuntimeConfigSnapshot();
  await configRuntime.captureRuntimeConfigAsyncReader()();
  // Prepare the real browser cleanup surface outside the provisional-session RPC deadline.
  await loadActivatedBundledPluginPublicSurfaceModule({
    dirName: "browser",
    artifactBasename: "browser-maintenance.js",
  });
  acpManager.testing.resetAcpSessionManagerForTests();
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockImplementation(
    () => getActivePluginRegistry() ?? createTestRegistry([]),
  );
});

afterEach(async () => {
  try {
    await disposeAcpSessionManagerInstance(acpManager.getAcpSessionManager(), "test-cleanup");
    acpManager.testing.resetAcpSessionManagerForTests();
    runtimeRegistry.unregisterAcpRuntimeBackend(backendId);
    await registryPersistence.settleSubagentRegistryPersistenceWork();
    await resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir });
  } finally {
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    spawnTesting.setDepsForTest();
    vi.restoreAllMocks();
    configRuntime.clearRuntimeConfigSnapshot();
    configRuntime.clearConfigCache();
    try {
      await flushLogger();
      resetLogger();
    } finally {
      env.restore();
    }
  }
  await rm(stateDir, { recursive: true, force: true });
});

it.each([
  ["runtime", "abort"],
  ["row", "admission close"],
  ["thread", "admission close"],
  ["thread", "live"],
  ["actor", "admission close"],
  ["metadata", "admission close"],
  ["initialized", "admission close"],
] as const)(
  "pending ACP spawn transfers work only from its live parent: %s / %s",
  async (stage, closure) => {
    const cfg = configRuntime.getRuntimeConfig();
    const storePath = await registryPersistence.writeSubagentSessionEntry({
      stateDir,
      ...parentScope,
      defaultSessionId: "parent-session",
    });
    const live = closure === "live";
    const thread = stage === "thread";
    const readChild = (sessionKey: string) =>
      sessionAccessor.loadSessionEntry({ sessionKey, agentId: "fixture" });
    if (live) {
      await sessionAccessor.upsertSessionEntryCore(parentScope, {
        inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"],
      });
      await sessionAccessor.recordSessionParticipant(parentScope, {
        identity: { type: "profile", id: "human-contributor" },
        promptedAt: 1,
      });
    }
    const context = await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
      () => gatewayScope.getPluginRuntimeGatewayRequestScope()!.context!,
    );
    const requestScope = {
      context,
      resolveGatewayContext: context.resolveGatewayContext,
      isWebchatConnect: () => false,
    };
    const work = new AsyncWorkScope();
    const trackExecution = context.trackExecution;
    context.trackExecution = (run) => work.track(() => trackExecution(run));
    const admission = admissionContext.prepareSystemAgentRunAdmission(
      cfg,
      parentRunId,
      "main",
      "acp-authority-test",
    );
    const parent = gatewayScope.withPluginRuntimeGatewayRequestScope(requestScope, () =>
      registerChatAbortController({
        target: captureSessionTarget({
          storeScope: storePath,
          sessionKey: parentSessionKey,
          incarnation: "parent-session",
          agentId: "main",
        }),
        runId: parentRunId,
        ...parentScope,
        sessionId: "parent-session",
        ownerConnId: "owner-connection",
        timeoutMs: 60_000,
        operationalRunInstance: admission.operationalRunInstance,
      }),
    );
    const admitted = await admission.admit("embedded");
    gatewayScope.bindGatewayContextResolver(admitted, context.resolveGatewayContext);
    parent.bindAgentRunDelegatedAuthority(
      admissionContext.getAdmittedRunDelegatedAuthority(admitted)!,
    );
    expect(admitted.executionIdentityToken).toBeUndefined();
    const entered = createDeferred<string>();
    const release = createDeferred();
    const pause = async (sessionKey: string) => {
      entered.resolve(sessionKey);
      await release.promise;
    };
    let childKey: string | undefined;
    const upsert = sessionAccessor.upsertSessionEntryCore;
    vi.spyOn(sessionAccessor, "upsertSessionEntryCore").mockImplementation(async (...args) => {
      const entry = await upsert(...args);
      childKey = args[0].sessionKey;
      if (stage === "row") {
        await pause(childKey);
      }
      return entry;
    });
    if (stage === "actor") {
      const run = vi.spyOn(SessionActorQueue.prototype, "run");
      run.mockImplementationOnce(function (this: SessionActorQueue, key, op) {
        run.mockRestore();
        return this.run(key, async (isCurrent) => {
          if (!childKey) {
            throw new Error("ACP actor started before its child entry existed");
          }
          await pause(childKey);
          return await op(isCurrent);
        });
      });
    } else if (stage === "initialized" || stage === "metadata") {
      const initialize = acpSpawnRuntime.initializeAcpSpawnRuntime;
      vi.spyOn(acpSpawnRuntime, "initializeAcpSpawnRuntime").mockImplementationOnce(
        async (params) => {
          const initialized = await initialize(params);
          if (stage === "initialized") {
            await pause(params.sessionKey);
          } else if (!admissionContext.getAdmittedRunDelegatedAuthority(admitted)) {
            lateMetadata(initialized.initialized.meta);
          }
          return initialized;
        },
      );
    }
    const lateMetadata = vi.fn();
    if (stage === "metadata") {
      const update = sessionEntryWorker.withSessionEntryWorker;
      let held = false;
      vi.spyOn(sessionEntryWorker, "withSessionEntryWorker").mockImplementation(async (...args) => {
        const updated = await update(...args);
        if (
          !held &&
          args[0].agentId === "fixture" &&
          childKey &&
          ensuredSessions.includes(childKey)
        ) {
          held = true;
          await pause(childKey);
        }
        return updated;
      });
    }
    const bindThread = vi.fn<NonNullable<bindings.SessionBindingAdapter["bind"]>>(async (input) =>
      createAcpSpawnSessionBinding({
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      }),
    );
    const bindingAdapter: bindings.SessionBindingAdapter = {
      channel: "discord",
      accountId: "default",
      capabilities: { placements: ["child"], bindSupported: true, unbindSupported: true },
      bind: bindThread,
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => [],
    };
    if (thread) {
      bindings.registerSessionBindingAdapter(bindingAdapter);
    }
    const pausesRuntime = stage === "runtime" || thread;
    const initializesRuntime = pausesRuntime || stage === "metadata" || stage === "initialized";
    const ensuredSessions: string[] = [];
    const closeRuntime = vi.fn(async () => {});
    const runtime: AcpRuntime = {
      ownerAwareSessions: 1,
      async ensureSession(input) {
        if (live) {
          const entry = readChild(input.sessionKey);
          expect({
            profiles: entry?.inheritedGitContributorProfileIds,
            participants: entry?.participants ?? [],
          }).toEqual({ profiles: ["human-contributor"], participants: [] });
        }
        ensuredSessions.push(input.sessionKey);
        if (pausesRuntime) {
          await pause(input.sessionKey);
        }
        return {
          sessionKey: input.sessionKey,
          agentId: input.agentId,
          backend: backendId,
          runtimeSessionName: input.sessionKey,
          backendSessionId: `fixture:${input.sessionKey}`,
        };
      },
      runTurn() {
        throw new Error("No external harness turn belongs in this boundary test");
      },
      async cancel() {},
      close: closeRuntime,
    };
    runtimeRegistry.registerAcpRuntimeBackend({ id: backendId, runtime });
    const dispatch = vi.fn();
    let acceptedRunId: string | undefined;
    spawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method !== "agent") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        dispatch(params);
        if (typeof params.sessionKey !== "string" || typeof params.idempotencyKey !== "string") {
          throw new Error("Accepted ACP work requires session and run identities");
        }
        acceptedRunId = params.idempotencyKey;
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const socket = vi.spyOn(gatewayCall, "callGateway").mockImplementation(async (request) => {
      if (request.method === "agent.wait") {
        return await new Promise<never>(() => {});
      }
      throw new Error("Raw WebSocket transport is unavailable");
    });
    const source = createSessionsSpawnTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      // Trusted tool construction facts the ACP child records in its lineage receipt.
      senderIsOwner: true,
      gitContributorProfileId: "human-contributor",
      expectedParentSessionId: "parent-session",
      requesterRunId: parentRunId,
      requesterTurnRunId: parentRunId,
      ...(thread
        ? {
            agentChannel: "discord",
            agentAccountId: "default",
            agentTo: "channel:parent-channel",
          }
        : {}),
    });
    let forwarded: Promise<unknown> | undefined;
    const observed = copyAgentToolMetadata(source, {
      ...source,
      execute: (...args) => {
        const pending = source.execute!(...args);
        forwarded = pending.catch((error: unknown) => error);
        return pending;
      },
    });
    const [tool] = finalizeAgentTools({
      tools: [observed],
      hookContext: { ...parentScope, config: cfg, runId: parentRunId },
      abortSignal: parent.controller.signal,
    });
    const wrapped = gatewayScope.withPluginRuntimeGatewayRequestScope(requestScope, () =>
      gatewayCaller.withGatewayToolCallerIdentity(
        gatewayCaller.createAdmittedGatewayToolCallerIdentity({
          ...parentScope,
          admittedRunContext: admitted,
          requesterOrigin: {
            sessionKey: parentSessionKey,
            operatorProfileId: "selected-user",
            delegatedCreatorProfileId: "causal-human",
          },
        }),
        () =>
          tool!.execute!("pending-acp", {
            task: "bounded child",
            runtime: "acp",
            agentId: "fixture",
            mode: "run",
            expectsCompletionMessage: false,
            ...(thread ? { thread: true } : {}),
          }),
      ),
    );
    const wrappedOutcome = wrapped.catch((error: unknown) => error);
    try {
      const childSessionKey = await awaitGateBeforeSettlement(
        entered.promise,
        wrapped,
        "ACP spawn settled before runtime initialization",
      );
      expect(subagentRuns.size).toBe(0);
      expect(readChild(childSessionKey)?.createdActor).toMatchObject({
        type: "agent",
        id: "main",
        delegatedBy: { type: "human", source: "profile", id: "causal-human" },
      });
      if (closure === "abort") {
        const reply = vi.fn();
        const request = { sessionKey: parentSessionKey, runId: parentRunId };
        await handleChatAbortRequest({
          req: { type: "req", id: "abort-parent", method: "chat.abort", params: request },
          params: request,
          context,
          respond: reply,
          client: { ...createSyntheticPluginRuntimeClient(), connId: "owner-connection" },
          isWebchatConnect: () => false,
        });
        expect(reply).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [parentRunId],
        });
        expect(await wrappedOutcome).toBeInstanceOf(Error);
      } else if (closure === "admission close") {
        admission.close();
        expect(parent.controller.signal.aborted).toBe(false);
      }
      expect(admissionContext.getAdmittedRunDelegatedAuthority(admitted) !== undefined).toBe(live);
      release.resolve();
      const result = await forwarded;
      const sourceBoundary = {
        entry: readChild(childSessionKey),
        closes: closeRuntime.mock.calls.length,
      };
      await wrappedOutcome;
      await work.drain();
      if (live) {
        expect(result).toMatchObject({ details: { status: "accepted", childSessionKey } });
        const events = (await listSessionStateEventsSince(childSessionKey, "fixture", 0)).events;
        expect(events.map((event) => event.kind)).toEqual(["created", "child_spawned"]);
        const spawned = events[1]!;
        expect(spawned).toMatchObject({ actorId: parentSessionKey, runId: acceptedRunId });
        expect(
          openOpenClawStateDatabase()
            .db.prepare(
              `SELECT last_seen_sequence, notified_sequence, material_sequence
             FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?`,
            )
            .get(parentSessionKey, childSessionKey),
        ).toEqual({
          last_seen_sequence: spawned.sequence,
          notified_sequence: spawned.sequence,
          material_sequence: spawned.sequence,
        });
        expect(sourceBoundary.entry).toMatchObject({
          spawnedBy: parentSessionKey,
          parentSessionKey,
          spawnedBySessionId: "parent-session",
          spawnedBySenderIsOwner: true,
        });
        expect(subagentRuns.get(acceptedRunId!)).toMatchObject({
          childSessionKey,
          requesterSessionKey: parentSessionKey,
        });
      } else {
        expect.soft(socket).not.toHaveBeenCalled();
        expect.soft(sourceBoundary, "cleaned before return").toEqual({
          entry: undefined,
          closes: Number(initializesRuntime),
        });
        expect.soft(readChild(childSessionKey)).toBeUndefined();
        expect.soft(result).toMatchObject({ details: { status: "error" } });
      }
      expect
        .soft({
          metadata: lateMetadata.mock.calls.length,
          ensuredSessions,
          threads: bindThread.mock.calls.length,
          dispatches: dispatch.mock.calls.length,
          registered: subagentRuns.size,
          closed: closeRuntime.mock.calls.length,
        })
        .toEqual({
          metadata: 0,
          ensuredSessions: initializesRuntime ? [childSessionKey] : [],
          threads: Number(thread && live),
          dispatches: Number(live),
          registered: Number(live),
          closed: Number(!live && initializesRuntime),
        });
    } finally {
      release.resolve();
      await forwarded;
      await wrappedOutcome;
      admission.close();
      parent.cleanup();
      await work.drain();
      const projection = getSessionRowProjection(context);
      projection?.dispose();
      await projection?.ensureMaterialized();
      if (thread) {
        bindings.unregisterSessionBindingAdapter({
          channel: "discord",
          accountId: "default",
          adapter: bindingAdapter,
        });
      }
    }
  },
);
