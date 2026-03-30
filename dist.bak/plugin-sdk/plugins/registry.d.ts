import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, OpenClawPluginChannelRegistration, OpenClawPluginCliRegistrar, OpenClawPluginCommandDefinition, OpenClawPluginHttpHandler, OpenClawPluginHttpRouteHandler, OpenClawPluginHookOptions, ProviderPlugin, OpenClawPluginService, OpenClawPluginToolFactory, PluginConfigUiHint, PluginDiagnostic, PluginLogger, PluginOrigin, PluginKind, PluginHookName, PluginHookHandlerMap, PluginHookRegistration as TypedPluginHookRegistration } from "./types.js";
export type PluginToolRegistration = {
    pluginId: string;
    factory: OpenClawPluginToolFactory;
    names: string[];
    optional: boolean;
    source: string;
};
export type PluginCliRegistration = {
    pluginId: string;
    register: OpenClawPluginCliRegistrar;
    commands: string[];
    source: string;
};
export type PluginHttpRegistration = {
    pluginId: string;
    handler: OpenClawPluginHttpHandler;
    source: string;
};
export type PluginHttpRouteRegistration = {
    pluginId?: string;
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    source?: string;
};
export type PluginChannelRegistration = {
    pluginId: string;
    plugin: ChannelPlugin;
    dock?: ChannelDock;
    source: string;
};
export type PluginProviderRegistration = {
    pluginId: string;
    provider: ProviderPlugin;
    source: string;
};
export type PluginHookRegistration = {
    pluginId: string;
    entry: HookEntry;
    events: string[];
    source: string;
};
export type PluginServiceRegistration = {
    pluginId: string;
    service: OpenClawPluginService;
    source: string;
};
export type PluginCommandRegistration = {
    pluginId: string;
    command: OpenClawPluginCommandDefinition;
    source: string;
};
export type PluginRecord = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    kind?: PluginKind;
    source: string;
    origin: PluginOrigin;
    workspaceDir?: string;
    enabled: boolean;
    status: "loaded" | "disabled" | "error";
    error?: string;
    toolNames: string[];
    hookNames: string[];
    channelIds: string[];
    providerIds: string[];
    gatewayMethods: string[];
    cliCommands: string[];
    services: string[];
    commands: string[];
    httpHandlers: number;
    hookCount: number;
    configSchema: boolean;
    configUiHints?: Record<string, PluginConfigUiHint>;
    configJsonSchema?: Record<string, unknown>;
};
export type PluginRegistry = {
    plugins: PluginRecord[];
    tools: PluginToolRegistration[];
    hooks: PluginHookRegistration[];
    typedHooks: TypedPluginHookRegistration[];
    channels: PluginChannelRegistration[];
    providers: PluginProviderRegistration[];
    gatewayHandlers: GatewayRequestHandlers;
    httpHandlers: PluginHttpRegistration[];
    httpRoutes: PluginHttpRouteRegistration[];
    cliRegistrars: PluginCliRegistration[];
    services: PluginServiceRegistration[];
    commands: PluginCommandRegistration[];
    diagnostics: PluginDiagnostic[];
};
export type PluginRegistryParams = {
    logger: PluginLogger;
    coreGatewayHandlers?: GatewayRequestHandlers;
    runtime: PluginRuntime;
};
export declare function createEmptyPluginRegistry(): PluginRegistry;
export declare function createPluginRegistry(registryParams: PluginRegistryParams): {
    registry: PluginRegistry;
    createApi: (record: PluginRecord, params: {
        config: OpenClawPluginApi["config"];
        pluginConfig?: Record<string, unknown>;
    }) => OpenClawPluginApi;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
    registerTool: (record: PluginRecord, tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: {
        name?: string;
        names?: string[];
        optional?: boolean;
    }) => void;
    registerChannel: (record: PluginRecord, registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
    registerProvider: (record: PluginRecord, provider: ProviderPlugin) => void;
    registerGatewayMethod: (record: PluginRecord, method: string, handler: GatewayRequestHandler) => void;
    registerCli: (record: PluginRecord, registrar: OpenClawPluginCliRegistrar, opts?: {
        commands?: string[];
    }) => void;
    registerService: (record: PluginRecord, service: OpenClawPluginService) => void;
    registerCommand: (record: PluginRecord, command: OpenClawPluginCommandDefinition) => void;
    registerHook: (record: PluginRecord, events: string | string[], handler: Parameters<typeof registerInternalHook>[1], opts: OpenClawPluginHookOptions | undefined, config: OpenClawPluginApi["config"]) => void;
    registerTypedHook: <K extends PluginHookName>(record: PluginRecord, hookName: K, handler: PluginHookHandlerMap[K], opts?: {
        priority?: number;
    }) => void;
};
