import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as configRuntime from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRequestGatewayMethodRegistry } from "../gateway/server-methods.js";
import { flushPendingSessionsChangedEvents } from "../gateway/server-methods/session-change-event.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "../gateway/server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import type { WorkerSessionPlacementRecord } from "../gateway/worker-environments/placement-record.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import * as preparedCatalog from "./prepared-model-catalog.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";

const runtime = vi.hoisted(() => ({
  prepare: vi.fn<typeof import("./model-runtime-choice.js").preparePublishedModelRuntimeChoice>(),
  thinkingCatalog: vi.fn(),
}));
vi.mock("./model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: runtime.prepare,
}));
vi.mock("./model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: runtime.thinkingCatalog,
}));
vi.mock("../status/status-text.js", () => ({ buildStatusText: async () => "Session status" }));

const catalog: ModelCatalogEntry[] = [
  { provider: "fixture", id: "default", name: "Default", reasoning: false },
  { provider: "fixture", id: "chosen", name: "Chosen", reasoning: false },
  {
    provider: "fixture",
    id: "native",
    name: "Native",
    reasoning: false,
    nativeRuntime: "status-native",
  },
];
const nativeHarness: AgentHarness = {
  id: "status-native",
  label: "Status native fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  async runAttempt() {
    throw new Error("Model selection must not start a turn");
  },
};
const originalRegistry = getActivePluginRegistry();
const onPatch = vi.fn();
let state: OpenClawTestState;
let cfg: OpenClawConfig;
let nextSession = 0;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
beforeEach(() => {
  cfg = {
    agents: {
      entries: { main: { default: true }, support: {} },
      defaults: {
        model: { primary: "fixture/default", fallbacks: ["fixture/chosen"] },
        models: {
          "fixture/default": {},
          "fixture/chosen": { alias: "chosen" },
          "fixture/native": {},
        },
        modelSelectionScope: "global",
        sandbox: { mode: "off", sessionToolsVisibility: "all" },
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          agentRuntime: { id: "openclaw" },
          models: catalog.map<ModelDefinitionConfig>((entry) => ({
            id: entry.id,
            name: entry.name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1024,
          })),
        },
      },
    },
  };
  configRuntime.setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(createEmptyPluginRegistry(), "status-model-test", "default");
  registerAgentHarness(nativeHarness);
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalog").mockResolvedValue(catalog);
  runtime.prepare.mockReset().mockResolvedValue({
    kind: "ready",
    runtimeId: nativeHarness.id,
    harness: nativeHarness,
    validate: () => undefined,
  });
  runtime.thinkingCatalog.mockReset().mockResolvedValue(catalog);
  onPatch.mockReset();
  registerInternalHook("session:patch", onPatch);
});
afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  await disposeSessionReadContexts();
  unregisterInternalHook("session:patch", onPatch);
  vi.restoreAllMocks();
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry, "status-model-test-restore", "default");
  } else {
    resetPluginRuntimeStateForTest();
  }
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture(
  options: {
    agentId?: string;
    sessionKey?: string;
    entry?: Partial<SessionEntry>;
  } = {},
) {
  const agentId = options.agentId ?? "main";
  const id = `status-selection-${++nextSession}`;
  const key = options.sessionKey ?? `agent:${agentId}:${id}`;
  const scope = { agentId, sessionKey: key };
  await upsertSessionEntryCore(scope, {
    sessionId: id,
    lifecycleRevision: `${id}-generation`,
    updatedAt: 1,
    permissionMode: "full",
    sandboxMode: "off",
    ...options.entry,
  });
  const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();
  const context = createGatewayRequestContext(
    makeContextParams({
      getAttachedGatewayMethodRegistry: createRequestGatewayMethodRegistry,
      broadcastToConnIds: broadcast,
      loadGatewayModelCatalogSnapshot: async (params) => ({
        agentId: params?.agentId ?? agentId,
        agentDir: state.agentDir(params?.agentId ?? agentId),
        workspaceDir: state.workspaceDir,
        config: cfg,
        catalogComplete: true,
        entries: catalog,
        routeVariants: catalog,
      }),
    }),
  );
  let current = true;
  const resolveGatewayContext = () => (current ? context : undefined);
  context.resolveGatewayContext = resolveGatewayContext;
  context.getSessionEventSubscriberConnIds = () => new Set(["status-observer"]);
  await initializeSessionReadContext(context);
  const tool = createSessionStatusTool({
    config: cfg,
    agentSessionKey: key,
    requesterAgentIdOverride: agentId,
  });
  return {
    scope,
    context,
    broadcast,
    read: () => expectDefined(loadSessionEntry(scope), "status session"),
    retireGateway: () => {
      current = false;
    },
    execute: (params: { model: string; sessionKey?: string }) =>
      withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext, isWebchatConnect: () => false },
        () =>
          withOperatorToolGatewayAuthority(
            { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId,
                  sessionKey: key,
                  operationalRunInstance: { instanceId: `${id}-instance`, runId: `${id}-run` },
                  receiptAuthority: () => true,
                  gatewayContextResolver: resolveGatewayContext,
                },
                () => tool.execute("status-selection", params),
              ),
          ),
      ),
  };
}

it("keeps scoped selections session-only and reports unchanged choices without patch effects", async () => {
  const other = await fixture({ sessionKey: "agent:main:main" });
  const otherBefore = other.read();
  const target = await fixture({ agentId: "support", sessionKey: "agent:support:main" });
  const configWrite = vi.spyOn(configRuntime, "mutateConfigFileWithRetry");
  const configBefore = structuredClone(cfg);

  expect((await target.execute({ sessionKey: "main", model: "chosen" })).details).toMatchObject({
    agentId: "support",
    changedModel: true,
  });
  const selected = target.read();
  expect(selected).toMatchObject({ providerOverride: "fixture", modelOverride: "chosen" });
  expect(selected.modelFallback).toBeUndefined();
  expect(other.read()).toEqual(otherBefore);
  expect(onPatch).toHaveBeenCalledOnce();
  await flushPendingSessionsChangedEvents(target.context);
  target.broadcast.mockClear();

  expect((await target.execute({ sessionKey: "main", model: "chosen" })).details).toMatchObject({
    changedModel: false,
  });
  expect(target.read()).toEqual(selected);
  await flushPendingSessionsChangedEvents(target.context);
  expect(onPatch).toHaveBeenCalledOnce();
  expect(target.broadcast).not.toHaveBeenCalled();

  expect((await target.execute({ model: "default" })).details).toMatchObject({
    changedModel: true,
  });
  const reset = target.read();
  expect(reset).toMatchObject({ modelOverrideSource: "default", liveModelSwitchPending: true });
  expect(reset.providerOverride).toBeUndefined();
  expect(reset.modelOverride).toBeUndefined();
  expect(reset.modelFallback).toBeUndefined();
  expect((await target.execute({ model: "fixture/default" })).details).toMatchObject({
    changedModel: false,
  });
  expect(target.read()).toEqual(reset);
  expect(onPatch).toHaveBeenCalledTimes(2);
  expect(configWrite).not.toHaveBeenCalled();
  expect(cfg).toEqual(configBefore);
});

it.each(["unavailable", "retired before commit"] as const)(
  "rejects a runtime that is %s through the status tool without changing the session",
  async (availability) => {
    const target = await fixture();
    const before = target.read();
    const message = "The selected runtime is no longer available.";
    runtime.prepare.mockResolvedValue(
      availability === "unavailable"
        ? { kind: "unavailable", message }
        : {
            kind: "ready",
            runtimeId: nativeHarness.id,
            harness: nativeHarness,
            validate: vi
              .fn<() => string | undefined>()
              .mockReturnValueOnce(undefined)
              .mockReturnValue(message),
          },
    );
    await expect(target.execute({ model: "fixture/native" })).rejects.toThrow(message);
    expect(target.read()).toEqual(before);
    expect(onPatch).not.toHaveBeenCalled();
  },
);

it("rejects a host-only selection when the status session requires a sandbox", async () => {
  const target = await fixture({ entry: { sandbox: "required" } });
  const before = target.read();
  await expect(target.execute({ model: "fixture/native" })).rejects.toThrow("requires a sandbox");
  expect(target.read()).toEqual(before);
  expect(onPatch).not.toHaveBeenCalled();
});

it("rejects a status selection that cannot serve the session's active worker placement", async () => {
  const target = await fixture();
  const before = target.read();
  const placement: WorkerSessionPlacementRecord = {
    sessionId: before.sessionId,
    sessionKey: target.scope.sessionKey,
    agentId: target.scope.agentId,
    state: "active",
    executionMode: "worker-turn",
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    environmentId: "status-worker",
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "a".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
  };
  target.context.workerSessionPlacementService = {
    getMany: () => new Map([[before.sessionId, placement]]),
  };
  await expect(target.execute({ model: "fixture/native" })).rejects.toThrow(
    "cannot select a runtime without cloud placement support",
  );
  expect(target.read()).toEqual(before);
  expect(onPatch).not.toHaveBeenCalled();
});

it.each(["sessionId", "lifecycleRevision"] as const)(
  "does not overwrite a status target whose %s changes during model preparation",
  async (identity) => {
    const target = await fixture();
    const replacement = { ...target.read(), [identity]: "replacement-identity" };
    let persistedReplacement: SessionEntry | undefined;
    const loadCatalog = target.context.loadGatewayModelCatalogSnapshot;
    vi.spyOn(target.context, "loadGatewayModelCatalogSnapshot").mockImplementationOnce(
      async (params) => {
        await upsertSessionEntryCore(target.scope, replacement);
        persistedReplacement = target.read();
        return await loadCatalog(params);
      },
    );
    await expect(target.execute({ model: "chosen" })).rejects.toThrow("changed before patch");
    expect(target.read()).toEqual(expectDefined(persistedReplacement, "persisted replacement"));
    expect(onPatch).not.toHaveBeenCalled();
  },
);

it("does not fall back to a local model write after its Gateway binding retires", async () => {
  const target = await fixture();
  const before = target.read();
  target.retireGateway();
  await expect(target.execute({ model: "chosen" })).rejects.toThrow("Gateway instance unavailable");
  expect(target.read()).toEqual(before);
  expect(onPatch).not.toHaveBeenCalled();
});

it("initializes a persisted status placeholder without sending an empty expected session ID", async () => {
  const target = await fixture({ entry: { sessionId: "" } });
  expect(target.read().sessionId).toBe("");
  expect((await target.execute({ model: "chosen" })).details).toMatchObject({ changedModel: true });
  expect(target.read()).toMatchObject({ providerOverride: "fixture", modelOverride: "chosen" });
  expect(target.read().sessionId).not.toBe("");
});
