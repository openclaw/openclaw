/**
 * Browser plugin registration helpers. This file keeps registration lazy while
 * advertising Browser tools, services, node-host commands, and audits.
 */
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { registerBrowserCliMetadata } from "./cli-metadata.js";
import { bindBrowserDashboardEvents } from "./src/browser-dashboard-events.js";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPE,
  SESSION_BROWSER_REQUEST_GATEWAY_METHOD,
} from "./src/browser-gateway-contract.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
} from "./src/browser-node-commands.js";
import { getOptionalBrowserStateRuntime } from "./src/browser-runtime-state.js";
import { createBrowserToolDefinition } from "./src/browser-tool-description.js";
import { getGatewayExtensionRelayModule } from "./src/browser/extension-relay.runtime.js";
import {
  initializeBrowserSessionTabStore,
  drainBrowserSessionTabStore,
  readBrowserDashboardSessionOwners,
} from "./src/browser/session-tab-store.js";
import {
  configureSystemProfileImportStateStore,
  type SystemProfileImportState,
} from "./src/browser/system-profile-import-state.js";

const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const logger = createSubsystemLogger("browser");
let hasBrowserNodeHostWork: (() => boolean) | undefined;
let hasBrowserProxyUploadWork: (() => boolean) | undefined;

const loadBrowserRegistrationRuntimeModule = createLazyRuntimeSurface(
  () => import("./register.runtime.js"),
  (runtime) => {
    hasBrowserNodeHostWork = runtime.hasBrowserNodeHostWork;
    return runtime;
  },
);
const loadBrowserUploadCleanupRuntimeModule = createLazyRuntimeSurface(
  () => import("./src/browser-proxy-upload-cleanup.runtime.js"),
  (runtime) => {
    hasBrowserProxyUploadWork = runtime.hasBrowserProxyUploadWork;
    return runtime;
  },
);

function deriveChatTypeFromSessionKey(
  sessionKey: string | undefined,
): "direct" | "group" | "channel" | undefined {
  const tokens = new Set(sessionKey?.toLowerCase().split(":") ?? []);
  const chatType = (["group", "channel", "direct"] as const).find((kind) => tokens.has(kind));
  return chatType ?? (tokens.has("dm") ? "direct" : undefined);
}

type BrowserToolOptions = NonNullable<
  Parameters<typeof import("./src/browser-tool.js").createBrowserTool>[0]
>;

function createLazyBrowserTool(
  opts?: BrowserToolOptions,
  config?: OpenClawPluginToolContext["runtimeConfig"],
): AnyAgentTool {
  const { binding, capabilities, metadata } = createBrowserToolDefinition(opts, () => config);
  return {
    ...metadata,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const { createBrowserTool } = await loadBrowserRegistrationRuntimeModule();
      const tool = createBrowserTool({
        ...opts,
        ...(binding ? { runToolBinding: binding } : {}),
        toolCapabilities: capabilities,
      });
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

function createBrowserToolOptions(ctx: OpenClawPluginToolContext): BrowserToolOptions {
  const mediaChannel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const mediaChatType = deriveChatTypeFromSessionKey(ctx.sessionKey);
  return {
    ...(ctx.browser?.sandboxBridgeUrl ? { sandboxBridgeUrl: ctx.browser.sandboxBridgeUrl } : {}),
    ...(ctx.browser?.allowHostControl !== undefined
      ? { allowHostControl: ctx.browser.allowHostControl }
      : {}),
    ...(ctx.sessionKey ? { agentSessionKey: ctx.sessionKey } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    ...(ctx.activeModel?.provider || ctx.activeModel?.modelId
      ? {
          activeModel: {
            provider: ctx.activeModel.provider,
            model: ctx.activeModel.modelId,
          },
        }
      : {}),
    ...(ctx.sessionKey || mediaChannel
      ? {
          mediaScope: {
            ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
            ...(mediaChannel ? { channel: mediaChannel } : {}),
            ...(mediaChatType ? { chatType: mediaChatType } : {}),
          },
        }
      : {}),
    ...(ctx.toolBindings && Object.hasOwn(ctx.toolBindings, "browser")
      ? { runToolBinding: ctx.toolBindings.browser }
      : {}),
  };
}

export const browserPluginReload = {
  restartPrefixes: ["browser"],
  hotPrefixes: [
    "browser.profiles",
    "browser.defaultProfile",
    "browser.headless",
    "browser.executablePath",
    "browser.attachOnly",
    "browser.cdpUrl",
    "browser.noSandbox",
    "browser.extraArgs",
    "browser.snapshotDefaults",
    "browser.tabCleanup",
    "browser.allowSystemProfileImport",
  ],
};

function createBrowserProxyNodeHostCommand(command: string): OpenClawPluginNodeHostCommand {
  return {
    command,
    cap: "browser",
    hasActiveWork: () =>
      (loadBrowserRegistrationRuntimeModule.peek() !== undefined &&
        hasBrowserNodeHostWork?.() !== false) ||
      (loadBrowserUploadCleanupRuntimeModule.peek() !== undefined &&
        hasBrowserProxyUploadWork?.() !== false),
    isAvailable: ({ config }) =>
      config.browser?.enabled !== false && config.nodeHost?.browserProxy?.enabled !== false,
    handle: async (paramsJSON, _io, context) => {
      const { runBrowserProxyCommand } = await loadBrowserRegistrationRuntimeModule();
      return await runBrowserProxyCommand(paramsJSON, command, context?.signal);
    },
    ...(command === BROWSER_PROXY_UPLOAD_COMMAND
      ? {
          watchAvailability: () => {
            void loadBrowserUploadCleanupRuntimeModule()
              .then(({ ensureBrowserProxyUploadCleanup }) => ensureBrowserProxyUploadCleanup())
              .catch((error: unknown) => {
                logger.warn(`browser proxy upload cleanup startup failed: ${String(error)}`);
              });
          },
        }
      : {}),
  };
}

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_COMMAND),
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_UPLOAD_COMMAND),
];

export const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[] = [
  async (ctx) => {
    const { collectBrowserSecurityAuditFindings } = await loadBrowserRegistrationRuntimeModule();
    return collectBrowserSecurityAuditFindings(ctx);
  },
];

function createLazyBrowserPluginService(
  runtime: ReturnType<typeof initializeBrowserSessionTabStore>,
): OpenClawPluginService {
  let service: OpenClawPluginService | null = null;
  let stopDashboardEvents: (() => Promise<void>) | undefined;
  let stopTabCleanup: (() => Promise<void>) | undefined;
  let accepting = false;
  return {
    id: "browser-control",
    // Policy changes drain the service's generation before adopting new values.
    // Profile-level refresh keeps the admitted policy until this owner stops.
    reload: {
      configPrefixes: [
        "browser.enabled",
        "browser.evaluateEnabled",
        "browser.ssrfPolicy",
        "browser.extensionRelay.allowLegacyAuth",
      ],
    },
    start: async (ctx) => {
      await Promise.all([stopTabCleanup?.(), stopDashboardEvents?.()]);
      stopDashboardEvents = ctx.gatewayEvents
        ? bindBrowserDashboardEvents(ctx.gatewayEvents, (message) => logger.warn(message))
        : undefined;
      if (isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVICE_ENV])) {
        const { createBrowserPluginService, stopBrowserControlService } =
          await loadBrowserRegistrationRuntimeModule();
        service ??= createBrowserPluginService({ stopOnDemand: stopBrowserControlService });
        await service.start(ctx);
      }
      const { startTrackedBrowserTabCleanupTimer } =
        await import("./src/browser/session-tab-cleanup.js");
      accepting = true;
      stopTabCleanup = startTrackedBrowserTabCleanupTimer({
        isCurrent: () => accepting && getOptionalBrowserStateRuntime() === runtime,
        getResolvedBrowserConfig: async () => {
          const { getBrowserControlState } = await import("./src/browser-control-state.js");
          return getBrowserControlState()?.resolved ?? null;
        },
        onWarn: (message) => logger.warn(message),
      });
    },
    stop: async (ctx) => {
      accepting = false;
      try {
        await Promise.all([stopTabCleanup?.(), stopDashboardEvents?.()]);
        stopTabCleanup = undefined;
        stopDashboardEvents = undefined;
        if (!service) {
          const loadedRuntime = loadBrowserRegistrationRuntimeModule.peek();
          if (!loadedRuntime) {
            return;
          }
          const { stopBrowserControlService } = await loadedRuntime;
          await stopBrowserControlService();
          return;
        }
        await service.stop?.(ctx);
      } finally {
        await drainBrowserSessionTabStore(runtime);
      }
    },
  };
}

export function registerBrowserPlugin(api: OpenClawPluginApi) {
  const runtime = initializeBrowserSessionTabStore(api.runtime);
  api.session.controls.registerControlUiDescriptor({
    id: "dashboard",
    surface: "widget",
    label: "Browser",
    description:
      "An interactive HTTP(S) browser dashboard. Session writers share an isolated session context with the agent's dashboard selector; administrators use the separate managed-profile browser. Author with dashboard widget_put.",
    requiredScopes: ["operator.sessions.write"],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          maxLength: 4096,
          description: "HTTP(S) website URL without embedded credentials",
        },
        profile: {
          type: "string",
          maxLength: 128,
          description:
            "Administrator-only local managed profile (default openclaw). Session browser uses the configured default profile; omit this property.",
        },
      },
    },
  });
  api.on("session_end", async (event) => {
    if (
      event.reason !== "deleted" ||
      !event.sessionKey ||
      getOptionalBrowserStateRuntime() !== runtime
    ) {
      return;
    }
    const dashboards = await readBrowserDashboardSessionOwners();
    if (
      getOptionalBrowserStateRuntime() !== runtime ||
      !dashboards.some((dashboard) => dashboard.sessionKey === event.sessionKey)
    ) {
      return;
    }
    const { reconcileBrowserDashboards } = await import("./src/browser-dashboard.js");
    if (getOptionalBrowserStateRuntime() !== runtime) {
      return;
    }
    await reconcileBrowserDashboards({
      sessionKeys: [event.sessionKey],
      onWarn: (message) => logger.warn(message),
    });
  });
  configureSystemProfileImportStateStore(
    api.runtime.state.openKeyedStore<SystemProfileImportState>({
      namespace: "browser.system-profile-import",
      maxEntries: 1,
    }),
  );
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => {
      const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
      return createLazyBrowserTool(createBrowserToolOptions(ctx), config);
    },
    { name: "browser", workspaceAccess: false },
  );
  registerBrowserCliMetadata(api);
  api.registerGatewayMethod(
    BROWSER_REQUEST_GATEWAY_METHOD,
    async (opts) => {
      const { handleBrowserGatewayRequest } = await loadBrowserRegistrationRuntimeModule();
      return await handleBrowserGatewayRequest(opts);
    },
    {
      scope: BROWSER_REQUEST_GATEWAY_SCOPE,
    },
  );
  api.registerGatewayMethod(
    SESSION_BROWSER_REQUEST_GATEWAY_METHOD,
    async (opts) => {
      const { handleSessionBrowserGatewayRequest } = await loadBrowserRegistrationRuntimeModule();
      return handleSessionBrowserGatewayRequest(opts);
    },
    {
      scope: "operator.write",
      sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
    },
  );
  for (const { path, client, loadUpgrade } of [
    {
      // Keep the relay path in sync with GATEWAY_EXTENSION_RELAY_PATH without eager loading.
      path: "/browser/extension",
      client: "the OpenClaw Chrome extension",
      loadUpgrade: async () =>
        (await getGatewayExtensionRelayModule()).handleGatewayExtensionUpgrade,
    },
    {
      path: "/browser/screencast",
      client: "the browser screencast",
      loadUpgrade: async () =>
        (await import("./src/browser/screencast/upgrade.js")).handleBrowserScreencastUpgrade,
    },
  ]) {
    api.registerHttpRoute({
      path,
      // Each upgrade handler validates its own authority before admitting the socket.
      auth: "plugin",
      match: "exact",
      handler: (_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end(`Upgrade Required: connect ${client} over WebSocket.`);
      },
      handleUpgrade: async (req, socket, head) => {
        // Direct socket activity prepares teardown consumed by lazy service shutdown.
        await loadBrowserRegistrationRuntimeModule();
        return await (
          await loadUpgrade()
        )(req, socket, head);
      },
    });
  }
  api.registerService(createLazyBrowserPluginService(runtime));
}
