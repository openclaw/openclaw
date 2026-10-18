// Keep cold handler imports outside the in-process request deadline.
import "../gateway/server-methods/sessions-mutations.js";
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
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import { activePlacement } from "../gateway/worker-environments/placement-suite.test-support.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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

function modelEntry(id: string): ModelCatalogEntry {
  return {
    provider: "fixture",
    id,
    name: id,
    reasoning: false,
    ...(id === "native" ? { nativeRuntime: "status-native" } : {}),
  };
}
const catalog = ["default", "chosen", "native"].map(modelEntry);
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

function modelConfig(policy = false): OpenClawConfig {
  const primary = policy ? "blocked" : "default";
  const fallback = policy ? "allowed" : "chosen";
  const entries = policy ? [primary, fallback].map(modelEntry) : catalog;
  return {
    agents: {
      entries: policy ? { main: {} } : { main: {}, support: {} },
      defaults: {
        model: { primary: `fixture/${primary}`, fallbacks: [`fixture/${fallback}`] },
        models: Object.fromEntries(
          entries.map(({ id }) => [
            `fixture/${id}`,
            id === fallback ? { alias: "chosen" } : policy ? { alias: id } : {},
          ]),
        ),
        ...(policy ? { modelPolicy: { allow: ["fixture/*"] } } : {}),
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
          models: entries.map<ModelDefinitionConfig>((entry) => ({
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
}

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
beforeEach(() => {
  cfg = modelConfig();
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
    sessionEntry?: SessionEntry;
    catalog?: ModelCatalogEntry[];
  } = {},
) {
  const agentId = options.agentId ?? "main";
  const id = `status-selection-${++nextSession}`;
  const key = options.sessionKey ?? `agent:${agentId}:${id}`;
  const scope = { agentId, sessionKey: key };
  await upsertSessionEntryCore(
    scope,
    options.sessionEntry ?? {
      sessionId: id,
      lifecycleRevision: `${id}-generation`,
      updatedAt: 1,
      permissionMode: "full",
      sandboxMode: "off",
      ...options.entry,
    },
  );
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
        entries: options.catalog ?? catalog,
        routeVariants: options.catalog ?? catalog,
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
  const gatewayScope = { context, resolveGatewayContext, isWebchatConnect: () => false };
  const withCaller = <T>(run: () => Promise<T>) =>
    withGatewayToolCallerIdentity(
      {
        agentId,
        sessionKey: key,
        operationalRunInstance: { instanceId: `${id}-instance`, runId: `${id}-run` },
        receiptAuthority: () => true,
        gatewayContextResolver: resolveGatewayContext,
      },
      run,
    );
  const execute = (params: { model: string; sessionKey?: string }) =>
    withPluginRuntimeGatewayRequestScope(gatewayScope, () =>
      withOperatorToolGatewayAuthority(
        { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
        () => withCaller(() => tool.execute("status-selection", params)),
      ),
    );
  return {
    scope,
    context,
    broadcast,
    tool,
    gatewayScope,
    withCaller,
    read: () => expectDefined(loadSessionEntry(scope), "status session"),
    retireGateway: () => {
      current = false;
    },
    execute,
    select: async (model: string, changedModel: boolean, sessionKey?: string) => {
      expect((await execute({ model, sessionKey })).details).toMatchObject({
        agentId,
        changedModel,
      });
    },
  };
}

it.each([false, true])(
  "keeps scoped selections session-only without duplicate patch effects (placeholder=%s)",
  async (placeholder) => {
    const other = await fixture({ sessionKey: "agent:main:main" });
    const otherBefore = other.read();
    const target = await fixture({
      agentId: "support",
      sessionKey: "agent:support:main",
      entry: placeholder ? { sessionId: "" } : {},
    });
    if (placeholder) {
      expect(target.read().sessionId).toBe("");
    }
    const configWrite = vi.spyOn(configRuntime, "mutateConfigFileWithRetry");
    const configBefore = structuredClone(cfg);

    await target.select("chosen", true, "main");
    const selected = target.read();
    expect(selected.sessionId).not.toBe("");
    expect(selected).toMatchObject({ providerOverride: "fixture", modelOverride: "chosen" });
    expect(selected.modelFallback).toBeUndefined();
    expect(other.read()).toEqual(otherBefore);
    expect(onPatch).toHaveBeenCalledOnce();
    await flushPendingSessionsChangedEvents(target.context);
    target.broadcast.mockClear();

    await target.select("chosen", false, "main");
    expect(target.read()).toEqual(selected);
    await flushPendingSessionsChangedEvents(target.context);
    expect(onPatch).toHaveBeenCalledOnce();
    expect(target.broadcast).not.toHaveBeenCalled();

    await target.select("default", true);
    const reset = target.read();
    expect(reset).toMatchObject({ modelOverrideSource: "default", liveModelSwitchPending: true });
    expect(reset.providerOverride).toBeUndefined();
    expect(reset.modelOverride).toBeUndefined();
    expect(reset.modelFallback).toBeUndefined();
    await target.select("fixture/default", false);
    expect(target.read()).toEqual(reset);
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(configWrite).not.toHaveBeenCalled();
    expect(cfg).toEqual(configBefore);
  },
);

it.each([
  ["retired before commit", "The selected runtime is no longer available."],
  ["sandbox", "requires a sandbox"],
  ["worker", "cannot select a runtime without cloud placement support"],
])("rejects an incompatible runtime (%s) without patch effects", async (availability, message) => {
  const target = await fixture({
    entry: availability === "sandbox" ? { sandbox: "required" } : {},
  });
  const before = target.read();
  if (availability === "retired before commit") {
    runtime.prepare.mockResolvedValue({
      kind: "ready",
      runtimeId: nativeHarness.id,
      harness: nativeHarness,
      validate: vi
        .fn<() => string | undefined>()
        .mockReturnValueOnce(undefined)
        .mockReturnValue(message),
    });
  } else if (availability === "worker") {
    const placement = activePlacement(before.sessionId, {
      sessionKey: target.scope.sessionKey,
      agentId: target.scope.agentId,
      generation: 1,
      environmentId: "status-worker",
      activeOwnerEpoch: 1,
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
    });
    target.context.workerSessionPlacementService = {
      getMany: () => new Map([[before.sessionId, placement]]),
      prepareSessionPlacement: async () => ({
        prepareRead: () => undefined,
        current: () => placement,
        release: () => {},
      }),
    };
  }
  await expect(target.execute({ model: "fixture/native" })).rejects.toThrow(message);
  expect(target.read()).toEqual(before);
  expect(onPatch).not.toHaveBeenCalled();
});

it.each(["sessionId", "lifecycleRevision", "Gateway"] as const)(
  "rejects a status target whose %s retires without overwriting it",
  async (identity) => {
    const target = await fixture();
    let expected: SessionEntry | undefined = identity === "Gateway" ? target.read() : undefined;
    if (identity === "Gateway") {
      target.retireGateway();
    } else {
      const replacement = { ...target.read(), [identity]: "replacement-identity" };
      const loadCatalog = target.context.loadGatewayModelCatalogSnapshot;
      vi.spyOn(target.context, "loadGatewayModelCatalogSnapshot").mockImplementationOnce(
        async (params) => {
          await upsertSessionEntryCore(target.scope, replacement);
          expected = target.read();
          return await loadCatalog(params);
        },
      );
    }
    await expect(target.execute({ model: "chosen" })).rejects.toThrow(
      identity === "Gateway" ? "Gateway instance unavailable" : "changed before patch",
    );
    expect(target.read()).toEqual(expectDefined(expected, "persisted replacement"));
    expect(onPatch).not.toHaveBeenCalled();
  },
);

it("routes status model changes through the original operator policy and preserves unrestricted callers", async () => {
  const limited = ensureProfileForEmail("limited-model@example.test");
  const unrestricted = ensureProfileForEmail("unrestricted-model@example.test");
  setUserProfileRole(unrestricted.id, "unrestricted");
  const policyCatalog = ["blocked", "allowed"].map(modelEntry);
  cfg = modelConfig(true);
  cfg.gateway = {
    roles: {
      default: "limited",
      definitions: {
        limited: {
          sessions: { others: "write" },
          agents: ["main"],
          scopes: ["operator.admin"],
          modelPolicy: { sourceAgent: "main", deny: ["fixture/blocked"] },
        },
        unrestricted: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
      },
    },
  };
  configRuntime.setRuntimeConfigSnapshot(cfg);
  vi.mocked(preparedCatalog.loadPublishedPreparedModelCatalog).mockResolvedValue(policyCatalog);
  // Operator policy uses real preparation; native-runtime cases inject availability failures.
  const actualRuntime = await vi.importActual<typeof import("./model-runtime-choice.js")>(
    "./model-runtime-choice.js",
  );
  runtime.prepare.mockImplementation(actualRuntime.preparePublishedModelRuntimeChoice);
  runtime.thinkingCatalog.mockImplementation(preparedCatalog.loadProviderScopedThinkingCatalog);
  const target = await fixture({
    sessionKey: "agent:main:status-model-policy",
    catalog: policyCatalog,
    sessionEntry: {
      sessionId: "model-policy-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: limited.id },
      providerOverride: "fixture",
      modelOverride: "blocked",
      agentRuntimeOverride: "openclaw",
    },
  });
  await withPluginRuntimeGatewayRequestScope(target.gatewayScope, async () => {
    const select = async (model: string, changedModel: boolean) => {
      expect((await target.tool.execute("selection", { model })).details).toMatchObject({
        changedModel,
      });
    };
    const runAs = <T>(profileId: string, run: () => Promise<T>) => {
      const client = sharingPolicyClient({ user: profileId, scopes: ["operator.admin"] });
      return withPluginRuntimeGatewayRequestScope({ ...target.gatewayScope, client }, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: expectDefined(
              client.authenticatedUserProfile,
              "operator profile",
            ),
            scopes: ["operator.admin"],
          },
          run,
        ),
      );
    };
    await target.withCaller(async () => {
      await runAs(limited.id, async () => {
        const before = target.read();
        for (const model of ["fixture/blocked", "blocked"]) {
          await expect(target.tool.execute("denied-selection", { model })).rejects.toThrow(
            "operator role cannot use this model",
          );
          expect(target.read()).toEqual(before);
        }
        await select("chosen", true);
        const selected = target.read();
        expect(selected).toMatchObject({ providerOverride: "fixture", modelOverride: "allowed" });
        await select("chosen", false);
        expect(target.read()).toEqual(selected);
        await select("default", true);
        expect(target.read().modelOverride).toBeUndefined();
        expect(target.context.getRuntimeConfig().agents?.defaults?.model).toEqual(
          cfg.agents?.defaults?.model,
        );
      });
      await runAs(unrestricted.id, async () => {
        await target.tool.execute("unrestricted-selection", { model: "fixture/blocked" });
        expect(target.read().modelOverride).toBeUndefined();
      });
    });
    await runAs(limited.id, () =>
      withPluginRuntimeGatewayRequestScope({ isWebchatConnect: () => false }, async () => {
        const before = target.read();
        await expect(target.tool.execute("missing-gateway", { model: "chosen" })).rejects.toThrow(
          "Operator model selection requires a current Gateway",
        );
        expect(target.read()).toEqual(before);
      }),
    );
  });
});
