import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMethodOwner } from "../gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import { authorizeGatewayRequestPreDispatch } from "../gateway/server-methods/request-authorization.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { makePluginMetadataIndex } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { buildPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import * as profileReader from "../state/user-profile-list.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const browserRuntime = { execute: vi.fn<AnyAgentTool["execute"]>() };
const readPublicItem = vi.fn<AnyAgentTool["execute"]>();

let registerBrowserPlugin: NonNullable<OpenClawPluginDefinition["register"]>;
const sessionKey = "agent:main:policy-regression";
const registries: PluginRegistry[] = [];
const releases: Array<() => void> = [];
const pluginOnlyPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: true,
};

function requireTool(tools: AnyAgentTool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected registered tool ${name}`);
  }
  return tool;
}

function assertCapturedPolicy(name: string) {
  const assertToolAllowed = getGatewayToolCallerIdentity()?.assertToolAllowed;
  if (!assertToolAllowed) {
    throw new Error("Missing captured tool assertion");
  }
  assertToolAllowed(name);
  return jsonResult({ allowed: name });
}

function assemble(allow: string[], deny: string[] = []) {
  const config: OpenClawConfig = {
    plugins: { allow: ["browser", "fixture-reader"], slots: { memory: "none" } },
    tools: { allow, deny, toolSearch: true },
  };
  const registry = createRuntimeTestRegistry(createPluginRuntime());
  registries.push(registry.registry);
  const manifests: PluginManifestRecord[] = [
    { id: "browser", toolName: "browser" },
    { id: "fixture-reader", toolName: "Read_Public_Item" },
  ].map(({ id, toolName }) => ({
    id,
    origin: "bundled",
    enabledByDefault: true,
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}/index.js`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    hooks: [],
    skills: [],
    contracts: { tools: id === "fixture-reader" ? ["select_public_item", toolName] : [toolName] },
  }));
  for (const manifest of manifests) {
    const record = createPluginRecord({
      id: manifest.id,
      source: manifest.source,
      rootDir: manifest.rootDir,
      origin: manifest.origin,
      contracts: manifest.contracts,
    });
    bindPluginRuntimeArtifactSelection(record, {
      runtimeEntry: { source: manifest.source, rootDir: manifest.rootDir },
      preferBuiltPluginArtifacts: false,
    });
    const api = registry.createApi(record, { config });
    if (manifest.id === "browser") {
      const registerTool = api.registerTool;
      // Exercise the plugin's real registration and tool metadata while isolating
      // browser I/O at the public registration boundary, not its private modules.
      api.registerTool = (factory, options) => {
        if (typeof factory !== "function") {
          throw new Error("Expected browser tool factory");
        }
        registerTool((context) => {
          const tool = factory(context);
          if (!tool || Array.isArray(tool)) {
            throw new Error("Expected one registered browser tool");
          }
          return { ...tool, execute: browserRuntime.execute };
        }, options);
      };
    }
    runPluginRegisterSyncInRegistry(
      manifest.id === "browser"
        ? registerBrowserPlugin
        : (pluginApi) => {
            pluginApi.registerTool(
              () => ({
                name: "Read_Public_Item",
                label: "Read public item",
                description: "Read a public fixture item",
                parameters: { type: "object", properties: {} },
                execute: readPublicItem,
              }),
              { names: ["select_public_item"], workspaceAccess: "execute" },
            );
            pluginApi.registerGatewayMethod("fixture-reader.read", () => {}, {
              scope: "operator.write",
              sessionAccess: {
                mode: "write",
                allowOwnSessionScope: true,
                requiredTool: " Read_Public_Item ",
              },
            });
          },
      api,
      registry.registry,
      manifest.id,
    );
  }
  const index = makePluginMetadataIndex();
  const snapshot = {
    ...buildPluginMetadataSnapshot(
      {
        policyHash: resolveInstalledPluginIndexPolicyHash(config),
        workspaceDir: "/tmp",
        index: { ...index, plugins: [] },
        registryIndex: { ...index, plugins: [] },
        registryDiagnostics: [],
        manifestRegistry: { plugins: manifests, diagnostics: [] },
        metrics: {
          registrySnapshotMs: 0,
          manifestRegistryMs: 0,
          ownerMapsMs: 0,
          totalMs: 0,
          indexPluginCount: 0,
          manifestPluginCount: 2,
        },
      },
      { config, env: process.env },
    ),
    normalizePluginId: (id: string) => id,
  };
  setGatewayPluginMetadataSnapshot(snapshot, { config, workspaceDir: "/tmp", env: process.env });
  setPluginRuntimeLoadContext(registry.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: "/tmp",
    env: process.env,
    logger: { info() {}, warn() {}, error() {} },
    manifestRegistry: snapshot.manifestRegistry,
    metadataSnapshot: snapshot,
  });
  const catalogRef = createToolSearchCatalogRef();
  const tools = withPluginRuntimeRegistryScope(registry.registry, () =>
    createOpenClawCodingTools({
      config,
      agentId: "main",
      sessionKey,
      workspaceDir: "/tmp",
      includeCoreTools: false,
      includeToolSearchControls: true,
      toolSearchCatalogRef: catalogRef,
      toolConstructionPlan: pluginOnlyPlan,
      wrapBeforeToolCallHook: false,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config,
        agentId: "main",
        sessionKey,
        workspaceDir: "/tmp",
        pluginMetadataSnapshot: snapshot,
      }),
    }),
  );
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return { tools, config, registry: registry.registry };
}

async function prepareResourceFixture(
  options: {
    methodOwner?: GatewayMethodOwner;
    toolName?: "browser" | "Read_Public_Item";
    allow?: string[];
    unrelatedAmbientRegistry?: boolean;
    missingSelectedRegistration?: boolean;
  } = {},
) {
  const toolName = options.toolName ?? "browser";
  const assembled = assemble(options.allow ?? ["group:plugins"]);
  let config = assembled.config;
  const entry: SessionEntry = {
    sessionId: "plugin-policy-session",
    lifecycleRevision: "plugin-policy-incarnation",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "alice" },
    visibility: "shared",
  };
  const target = {
    agentId: "main",
    canonicalKey: sessionKey,
    entry,
    generation: Symbol("session-database"),
    storePath: "/test/sessions",
    storeKey: sessionKey,
    storeKeys: [sessionKey],
  };
  const projection = {
    prepareMembership: async () => {},
    sharingTarget: () => target,
    sharingTargetState: () => ({ status: "ready", target }),
    hasMembership: () => false,
  } as unknown as SessionRowProjection;
  const context = bindSessionRowProjection(createContext(), () => projection);
  context.getRuntimeConfig = () => config;
  const emptyRegistry = createRuntimeTestRegistry(createPluginRuntime()).registry;
  registries.push(emptyRegistry);
  const methodRegistry = createGatewayMethodRegistry(
    assembled.registry.gatewayMethodDescriptors.map((descriptor) =>
      options.methodOwner ? { ...descriptor, owner: options.methodOwner } : descriptor,
    ),
    options.missingSelectedRegistration ? emptyRegistry : assembled.registry,
  );
  context.getGatewayMethodRegistry = () => methodRegistry;
  const client = createOperatorClient({ profileId: "alice", scopes: ["operator.sessions.write"] });
  client.internal = { syntheticClient: true };
  const admission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId: "plugin-policy-run",
      agentId: "main",
      ingress: { kind: "system", boundary: "plugin-policy-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("plugin-policy-run"),
  });
  releases.push(admission.close);
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: await admission.admit("plugin-harness", "plugin-policy-harness"),
    agentId: "main",
    sessionKey,
  });
  if (!caller) {
    throw new Error("Admitted resource caller is missing");
  }
  const methodName = toolName === "browser" ? "browser.dashboard.request" : "fixture-reader.read";
  const descriptor = methodRegistry.descriptors().find((method) => method.name === methodName);
  const policy = descriptor?.sessionAccess;
  if (!descriptor || !policy) {
    throw new Error("Registered session-access policy is missing");
  }
  let beforeEffect = () => {};
  const effect = vi.fn();
  const execute = toolName === "browser" ? browserRuntime.execute : readPublicItem;
  execute.mockImplementation(async () => {
    const authorization = await withPluginRuntimeRegistryScope(
      options.unrelatedAmbientRegistry ? emptyRegistry : assembled.registry,
      () =>
        authorizeGatewayRequestPreDispatch({
          method: methodName,
          methodRegistry,
          requestParams: { agentId: "main", sessionKey },
          client,
          context,
        }),
    );
    if (authorization.error) {
      throw new Error(authorization.error.message);
    }
    const authority = authorization.sessionAccessAuthority;
    if (!authority) {
      throw new Error("Session access authority is missing");
    }
    try {
      beforeEffect();
      authority.assertCurrent();
      effect();
      return jsonResult({ allowed: toolName });
    } finally {
      authority.release();
    }
  });
  return {
    tools: assembled.tools,
    effect,
    beforeEffect(callback: () => void) {
      beforeEffect = callback;
    },
    denyTool(deny: string) {
      config = { ...config, tools: { ...config.tools, deny: [deny] } };
    },
    execute(route: "direct" | "dispatch_action", assertToolAllowed?: (name: string) => void) {
      const args = toolName === "browser" ? { action: "status" } : {};
      return withPluginRuntimeRegistryScope(assembled.registry, () =>
        withGatewayToolCallerIdentity({ ...caller, assertToolAllowed }, () =>
          requireTool(assembled.tools, route === "direct" ? toolName : route).execute(
            "browser-policy",
            route === "direct" ? args : { id: toolName, args },
          ),
        ),
      );
    },
  };
}

describe("captured registered plugin tool policy", () => {
  beforeAll(async () => {
    const surface = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
      pluginId: "browser",
      artifactBasename: "index.js",
    });
    if (!surface.default.register) {
      throw new Error("Browser plugin registration is missing");
    }
    registerBrowserPlugin = surface.default.register;
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(
      registries.splice(0).map((registry) => disposePluginRegistryInstances(registry)),
    );
    clearCurrentPluginMetadataSnapshot();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    readPublicItem.mockReset();
    readPublicItem.mockImplementation(async () => assertCapturedPolicy("Read_Public_Item"));
    browserRuntime.execute.mockReset();
    browserRuntime.execute.mockImplementation(async () => assertCapturedPolicy("browser"));
    vi.spyOn(profileReader, "prepareUserProfileIdentity").mockImplementation(async (profileId) => ({
      readCurrentRevision: () => ({ profileId }),
      readCurrentProfile: () => ({ profileId, assignedRole: null }),
      emailBindingIds: [],
      readCurrentFacts: () => ({
        profile: { profileId, assignedRole: null, emails: [] },
        aliases: new Set([profileId]),
      }),
      release() {},
    }));
    vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementation(
      async (profileId) => ({
        profileId,
        role: null,
        display: { id: profileId, displayName: "Alice", hasAvatar: false, avatarRevision: "test" },
        readSource: () => ({ path: "/test/profiles.sqlite", env: { OPENCLAW_STATE_DIR: "/test" } }),
        aliases: [profileId],
        isCurrent: () => true,
      }),
    );
  });

  it.each(["direct", "dispatch_action"] as const)(
    "retains the browser plugin group allow through %s execution",
    async (route) => {
      const fixture = await prepareResourceFixture();
      const browser = requireTool(fixture.tools, "browser");
      expect(getPluginToolMeta(browser)?.pluginId).toBe("browser");
      const result = await fixture.execute(route);
      expect(JSON.stringify(result)).toContain('"allowed":"browser"');
      expect(fixture.effect).toHaveBeenCalledOnce();
    },
  );

  it("retains plugin-ID allowance with case and reference whitespace", async () => {
    const fixture = await prepareResourceFixture({
      toolName: "Read_Public_Item",
      allow: ["fixture-reader"],
    });
    await expect(fixture.execute("direct")).resolves.toMatchObject({
      details: { allowed: "Read_Public_Item" },
    });
    expect(fixture.effect).toHaveBeenCalledOnce();
  });

  it.each(["Read_Public_Item", "fixture-reader", "group:plugins"])(
    "keeps %s denied in the assembled surface",
    (deny) => {
      const { tools } = assemble(["group:plugins"], [deny]);
      expect(tools.map((tool) => tool.name)).not.toContain("Read_Public_Item");
    },
  );

  it("does not treat unregistered names or caller-supplied plugin IDs as ownership", async () => {
    const { tools } = assemble(["group:plugins"], ["Read_Public_Item"]);
    browserRuntime.execute.mockImplementation(async () => {
      const assertToolAllowed = getGatewayToolCallerIdentity()?.assertToolAllowed;
      expect(assertToolAllowed).toBeTypeOf("function");
      for (const name of ["unregistered_action", "Read_Public_Item", "exec"]) {
        expect(() => assertToolAllowed?.(name)).toThrow("is not allowed by this conversation");
      }
      return assertCapturedPolicy("browser");
    });
    await expect(
      requireTool(tools, "browser").execute("spoofed-owner", {
        action: "status",
        pluginId: "browser",
        toolName: "unregistered_action",
      }),
    ).resolves.toMatchObject({ details: { allowed: "browser" } });
  });

  it("preserves a narrower outer caller restriction through dispatch", async () => {
    const fixture = await prepareResourceFixture();
    const assertToolAllowed = vi.fn((name: string) => {
      if (name === "browser") {
        throw new Error("outer caller denies browser");
      }
    });
    await expect(fixture.execute("dispatch_action", assertToolAllowed)).rejects.toThrow(
      "outer caller denies browser",
    );
    expect(assertToolAllowed).toHaveBeenCalledWith("browser");
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it.each([
    { toolName: "browser", deny: "browser" },
    { toolName: "browser", deny: "group:plugins" },
    { toolName: "Read_Public_Item", deny: "fixture-reader" },
    { toolName: "Read_Public_Item", deny: "group:plugins" },
  ] as const)(
    "rechecks current $deny denial before $toolName effects",
    async ({ toolName, deny }) => {
      const fixture = await prepareResourceFixture({
        toolName,
        allow: toolName === "browser" ? [toolName] : [toolName, "select_public_item"],
        unrelatedAmbientRegistry: true,
      });
      fixture.beforeEffect(() => fixture.denyTool(deny));
      await expect(fixture.execute("direct")).rejects.toThrow("current tool policy does not allow");
      expect(fixture.effect).not.toHaveBeenCalled();
    },
  );

  it("uses selected method registration when the ambient registry differs", async () => {
    const fixture = await prepareResourceFixture({ unrelatedAmbientRegistry: true });
    await expect(fixture.execute("direct")).resolves.toMatchObject({
      details: { allowed: "browser" },
    });
    expect(fixture.effect).toHaveBeenCalledOnce();
  });

  it("does not borrow registration from the ambient registry", async () => {
    const fixture = await prepareResourceFixture({ missingSelectedRegistration: true });
    await expect(fixture.execute("direct")).rejects.toThrow("current tool policy does not allow");
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it.each<GatewayMethodOwner>([
    { kind: "core", area: "fixture" },
    { kind: "plugin", pluginId: "fixture-reader" },
    { kind: "plugin", pluginId: "unregistered" },
  ])("does not lend browser ownership to another method owner: %j", async (methodOwner) => {
    const fixture = await prepareResourceFixture({ methodOwner });
    await expect(fixture.execute("direct")).rejects.toThrow("current tool policy does not allow");
    expect(fixture.effect).not.toHaveBeenCalled();
  });
});
