import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginManagedMcpServer,
} from "openclaw/plugin-sdk/plugin-entry";
import { acquireChatgptAppsSidecarSession } from "./app-server-supervisor.js";
import type { ChatgptAppsResolvedAuth } from "./auth-projector.js";
import type { Tool as RemoteTool } from "./codex-sdk/generated/protocol/Tool.js";
import type { AppInfo } from "./codex-sdk/generated/protocol/v2/AppInfo.js";
import type { McpServerStatus } from "./codex-sdk/generated/protocol/v2/McpServerStatus.js";
import type { Unsubscribe } from "./codex-sdk/subscriptions.js";
import { resolveChatgptAppsConfig } from "./config.js";
import {
  createRemoteCodexAppsClient,
  type RemoteCodexAppsClient,
  type RemoteCodexAppsClientFactory,
} from "./remote-codex-apps-client.js";

export const MANAGED_MCP_SERVER_NAME = "openai-chatgpt-apps";
const ROUTING_META_KEY = "openclaw/chatgpt-apps";

type BridgeRoute = {
  connectorId: string;
  remoteName: string;
};

type BridgeToolCache = {
  authKey: string;
  inventoryKey: string;
  tools: Tool[];
  routes: Map<string, BridgeRoute>;
};

type BridgeSnapshotState = {
  auth: Extract<ChatgptAppsResolvedAuth, { status: "ok" }>;
  inventory: AppInfo[];
  statuses: McpServerStatus[];
  authKey: string;
  inventoryKey: string;
};

type BridgeSession = {
  refreshInventory(params: { forceRefetch: boolean }): Promise<AppInfo[]>;
  listMcpServerStatus(): Promise<McpServerStatus[]>;
  onInventoryUpdate(listener: (snapshot: { apps: AppInfo[] }) => void): Unsubscribe;
  snapshot(): {
    auth: ChatgptAppsResolvedAuth | null;
  };
};

type BridgeLease = {
  session: BridgeSession;
  release(): Promise<void>;
};

type AcquireBridgeLease = typeof acquireChatgptAppsSidecarSession;
type McpToolSchema = Tool["inputSchema"] & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function sanitizeJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonSchemaNode(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(value[combinator]) && value[combinator].length > 0) {
      const preferredBranch =
        value[combinator].find((entry) => !(isRecord(entry) && entry.type === "null")) ??
        value[combinator][0];
      const sanitizedBranch = sanitizeJsonSchemaNode(preferredBranch);
      if (!isRecord(sanitizedBranch)) {
        return sanitizedBranch;
      }

      const merged = { ...sanitizedBranch };
      if (!("title" in merged) && typeof value.title === "string") {
        merged.title = value.title;
      }
      if (!("description" in merged) && typeof value.description === "string") {
        merged.description = value.description;
      }
      if (!("default" in merged) && value.default !== null && value.default !== undefined) {
        merged.default = sanitizeJsonSchemaNode(value.default);
      }
      return merged;
    }
  }

  const sanitized: Record<string, unknown> = { ...value };

  if (isRecord(sanitized.properties)) {
    sanitized.properties = Object.fromEntries(
      Object.entries(sanitized.properties).map(([key, child]) => [
        key,
        sanitizeJsonSchemaNode(child),
      ]),
    );
  }
  if ("items" in sanitized) {
    sanitized.items = sanitizeJsonSchemaNode(sanitized.items);
  }
  if (isRecord(sanitized.additionalProperties)) {
    sanitized.additionalProperties = sanitizeJsonSchemaNode(sanitized.additionalProperties);
  }

  if (sanitized.default === null) {
    delete sanitized.default;
  } else if ("default" in sanitized) {
    sanitized.default = sanitizeJsonSchemaNode(sanitized.default);
  }

  const schemaType = sanitized.type;
  const hasValidType =
    (typeof schemaType === "string" && JSON_SCHEMA_TYPES.has(schemaType)) ||
    (Array.isArray(schemaType) &&
      schemaType.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry)));
  if (!hasValidType) {
    if (isRecord(sanitized.properties)) {
      sanitized.type = "object";
    } else if ("items" in sanitized) {
      sanitized.type = "array";
    } else {
      sanitized.type = "object";
      sanitized.additionalProperties =
        typeof sanitized.additionalProperties === "boolean" ? sanitized.additionalProperties : true;
    }
  }

  delete sanitized.anyOf;
  delete sanitized.oneOf;
  delete sanitized.allOf;

  return sanitized;
}

function sanitizeToolSchema(inputSchema: unknown): McpToolSchema {
  const sanitized = sanitizeJsonSchemaNode(inputSchema);
  if (!isRecord(sanitized)) {
    return {
      type: "object",
      additionalProperties: true,
    } as McpToolSchema;
  }

  const properties = isRecord(sanitized.properties)
    ? Object.fromEntries(
        Object.entries(sanitized.properties).flatMap(([key, value]) =>
          isRecord(value) ? [[key, value as object]] : [],
        ),
      )
    : undefined;
  const required = Array.isArray(sanitized.required)
    ? sanitized.required.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    ...sanitized,
    type: "object",
    ...(properties ? { properties } : {}),
    ...(required ? { required } : {}),
  } as McpToolSchema;
}

function sanitizeToolAnnotations(annotations: unknown): Tool["annotations"] | undefined {
  if (!isRecord(annotations)) {
    return undefined;
  }

  const sanitized: NonNullable<Tool["annotations"]> = {};
  if (typeof annotations.title === "string") {
    sanitized.title = annotations.title;
  }
  if (typeof annotations.readOnlyHint === "boolean") {
    sanitized.readOnlyHint = annotations.readOnlyHint;
  }
  if (typeof annotations.destructiveHint === "boolean") {
    sanitized.destructiveHint = annotations.destructiveHint;
  }
  if (typeof annotations.idempotentHint === "boolean") {
    sanitized.idempotentHint = annotations.idempotentHint;
  }
  if (typeof annotations.openWorldHint === "boolean") {
    sanitized.openWorldHint = annotations.openWorldHint;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeToolIcons(icons: unknown): Tool["icons"] | undefined {
  if (!Array.isArray(icons)) {
    return undefined;
  }

  const sanitizedIcons = icons.flatMap((icon) => {
    if (!isRecord(icon) || typeof icon.src !== "string") {
      return [];
    }

    const sanitizedIcon: NonNullable<Tool["icons"]>[number] = {
      src: icon.src,
    };
    if (typeof icon.mimeType === "string") {
      sanitizedIcon.mimeType = icon.mimeType;
    }
    if (Array.isArray(icon.sizes)) {
      sanitizedIcon.sizes = icon.sizes.filter((size): size is string => typeof size === "string");
    }
    if (icon.theme === "light" || icon.theme === "dark") {
      sanitizedIcon.theme = icon.theme;
    }
    return [sanitizedIcon];
  });

  return sanitizedIcons.length > 0 ? sanitizedIcons : undefined;
}

function rewriteToolName(connectorId: string, remoteToolName: string): string {
  return `chatgpt_app__${connectorId}__${remoteToolName}`;
}

function normalizeConnectorKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function looksLikeOpaqueAppId(value: string): boolean {
  return value.startsWith("connector_") || value.startsWith("asdk_app_");
}

function deriveConnectorKeysFromApp(app: AppInfo): string[] {
  const candidates = new Set<string>();

  if (!looksLikeOpaqueAppId(app.id)) {
    const normalizedId = normalizeConnectorKey(app.id);
    if (normalizedId) {
      candidates.add(normalizedId);
    }
  }

  for (const value of [app.name, ...app.pluginDisplayNames]) {
    const normalized = normalizeConnectorKey(value);
    if (normalized) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function resolveConnectorIdForRemoteToolName(
  remoteToolName: string,
  allowedConnectorIds: Set<string>,
): string | null {
  const sortedConnectorIds = [...allowedConnectorIds].sort(
    (left, right) => right.length - left.length,
  );
  for (const connectorId of sortedConnectorIds) {
    if (remoteToolName === connectorId || remoteToolName.startsWith(`${connectorId}_`)) {
      return connectorId;
    }
  }
  return null;
}

function buildInventoryKey(params: { inventory: AppInfo[]; statuses: McpServerStatus[] }): string {
  return JSON.stringify({
    inventory: params.inventory.map((app) => ({
      id: app.id,
      connectorKeys: deriveConnectorKeysFromApp(app),
      isAccessible: app.isAccessible,
      isEnabled: app.isEnabled,
    })),
    statuses: params.statuses.map((status) => ({
      name: status.name,
      tools: Object.values(status.tools ?? {})
        .map((tool) => tool?.name)
        .filter((name): name is string => typeof name === "string")
        .sort(),
    })),
  });
}

function buildAllowedConnectorIds(params: {
  inventory: AppInfo[];
  configuredConnectors: Record<string, { enabled: boolean }>;
}): Set<string> {
  const configuredConnectorIds = Object.entries(params.configuredConnectors)
    .map(([connectorId, connector]) => ({
      connectorId: normalizeConnectorKey(connectorId),
      enabled: connector.enabled,
    }))
    .filter((entry) => entry.connectorId);

  if (Object.keys(params.configuredConnectors).length > 0) {
    const allowed = new Set<string>();
    const wildcardEnabled =
      params.configuredConnectors["*"] && params.configuredConnectors["*"]?.enabled === true;
    const enabledSet = new Set(
      configuredConnectorIds.filter((entry) => entry.enabled).map((entry) => entry.connectorId),
    );
    const disabledSet = new Set(
      configuredConnectorIds.filter((entry) => !entry.enabled).map((entry) => entry.connectorId),
    );
    for (const app of params.inventory) {
      if (!app.isAccessible) {
        continue;
      }
      for (const connectorId of deriveConnectorKeysFromApp(app)) {
        if (disabledSet.has(connectorId)) {
          continue;
        }
        if (wildcardEnabled || enabledSet.has(connectorId)) {
          allowed.add(connectorId);
        }
      }
    }
    return allowed;
  }

  const allowed = new Set<string>();
  for (const app of params.inventory) {
    if (!app.isAccessible || !app.isEnabled) {
      continue;
    }
    for (const connectorId of deriveConnectorKeysFromApp(app)) {
      allowed.add(connectorId);
    }
  }
  return allowed;
}

function buildRemoteToolConnectorMap(params: {
  statuses: McpServerStatus[];
  allowedConnectorIds: Set<string>;
}): Map<string, string> {
  const toolToConnector = new Map<string, string>();

  for (const status of params.statuses) {
    for (const [toolName, tool] of Object.entries(status.tools ?? {})) {
      const resolvedName = tool?.name ?? toolName;
      if (!resolvedName || toolToConnector.has(resolvedName)) {
        continue;
      }

      const normalizedStatusName = normalizeConnectorKey(status.name);
      const connectorId = params.allowedConnectorIds.has(normalizedStatusName)
        ? normalizedStatusName
        : resolveConnectorIdForRemoteToolName(resolvedName, params.allowedConnectorIds);
      if (!connectorId) {
        continue;
      }
      toolToConnector.set(resolvedName, connectorId);
    }
  }

  return toolToConnector;
}

function withRoutingMetadata(tool: RemoteTool, route: BridgeRoute): Tool {
  const existingMeta = isRecord(tool._meta) ? tool._meta : {};
  const outputSchema =
    tool.outputSchema === undefined ? undefined : sanitizeToolSchema(tool.outputSchema);
  return {
    ...tool,
    name: rewriteToolName(route.connectorId, route.remoteName),
    inputSchema: sanitizeToolSchema(tool.inputSchema),
    outputSchema,
    annotations: sanitizeToolAnnotations(tool.annotations),
    icons: sanitizeToolIcons(tool.icons),
    _meta: {
      ...existingMeta,
      [ROUTING_META_KEY]: {
        connectorId: route.connectorId,
        remoteName: route.remoteName,
      },
    },
  };
}

function resolveBridgeAuth(
  auth: ChatgptAppsResolvedAuth | null,
): Extract<ChatgptAppsResolvedAuth, { status: "ok" }> {
  if (!auth || auth.status !== "ok") {
    throw new Error(auth?.message ?? "ChatGPT apps auth is not available.");
  }
  return auth;
}

export class ChatgptAppsMcpBridge {
  private readonly config;
  private readonly server: Server;
  private readonly acquireLease: AcquireBridgeLease;
  private readonly remoteClientFactory: RemoteCodexAppsClientFactory;
  private readonly stateDir: string;
  private readonly workspaceDir?: string;
  private readonly openclawConfig: OpenClawConfig;
  private readonly env: NodeJS.ProcessEnv;
  private lease: BridgeLease | null = null;
  private leasePromise: Promise<BridgeLease> | null = null;
  private remoteClientState: {
    authKey: string;
    client: RemoteCodexAppsClient;
  } | null = null;
  private remoteClientPromise: Promise<RemoteCodexAppsClient> | null = null;
  private toolCache: BridgeToolCache | null = null;
  private toolCachePromise: Promise<BridgeToolCache> | null = null;
  private inventoryUnsubscribe: Unsubscribe | null = null;

  constructor(params: {
    stateDir: string;
    workspaceDir?: string;
    config: OpenClawConfig;
    pluginConfig: unknown;
    env?: NodeJS.ProcessEnv;
    acquireLease?: AcquireBridgeLease;
    remoteClientFactory?: RemoteCodexAppsClientFactory;
  }) {
    this.stateDir = params.stateDir;
    this.workspaceDir = params.workspaceDir;
    this.openclawConfig = params.config;
    this.config = resolveChatgptAppsConfig(params.pluginConfig);
    this.env = params.env ?? process.env;
    this.acquireLease = params.acquireLease ?? acquireChatgptAppsSidecarSession;
    this.remoteClientFactory = params.remoteClientFactory ?? createRemoteCodexAppsClient;
    this.server = new Server(
      {
        name: MANAGED_MCP_SERVER_NAME,
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (request.params?.cursor) {
        return { tools: [] };
      }
      if (!this.config.enabled) {
        return { tools: [] };
      }
      const cache = await this.getToolCache();
      return {
        tools: cache.tools,
      };
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        if (!this.config.enabled) {
          throw new Error("ChatGPT apps are disabled in the OpenAI plugin config.");
        }

        const cache = await this.getToolCache();
        let route = cache.routes.get(request.params.name);
        if (!route) {
          this.toolCache = null;
          route = (await this.getToolCache()).routes.get(request.params.name);
        }
        if (!route) {
          throw new Error(`Unknown ChatGPT app tool: ${request.params.name}`);
        }

        const auth = await this.getCurrentAuth();
        const remoteClient = await this.getRemoteClient(auth);
        return await remoteClient.callTool({
          name: route.remoteName,
          arguments: request.params.arguments,
        });
      },
    );
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    this.inventoryUnsubscribe?.();
    this.inventoryUnsubscribe = null;
    this.toolCache = null;
    this.toolCachePromise = null;

    const remoteState = this.remoteClientState;
    this.remoteClientState = null;
    this.remoteClientPromise = null;
    if (remoteState) {
      await remoteState.client.close();
    }

    const lease = this.lease;
    this.lease = null;
    this.leasePromise = null;
    if (lease) {
      await lease.release();
    }

    await this.server.close();
  }

  private async getLease(): Promise<BridgeLease> {
    if (this.lease) {
      return this.lease;
    }
    if (this.leasePromise) {
      return await this.leasePromise;
    }

    this.leasePromise = this.acquireLease({
      stateDir: this.stateDir,
      workspaceDir: this.workspaceDir,
      config: this.config,
      openclawConfig: this.openclawConfig,
      env: this.env,
    });
    try {
      this.lease = await this.leasePromise;
      this.inventoryUnsubscribe = this.lease.session.onInventoryUpdate(() => {
        this.invalidateToolCache();
        void this.server.sendToolListChanged().catch(() => {});
      });
      return this.lease;
    } finally {
      this.leasePromise = null;
    }
  }

  private invalidateToolCache(): void {
    this.toolCache = null;
    this.toolCachePromise = null;
  }

  private async getCurrentAuth(): Promise<Extract<ChatgptAppsResolvedAuth, { status: "ok" }>> {
    const lease = await this.getLease();
    await lease.session.refreshInventory({ forceRefetch: false });
    return resolveBridgeAuth(lease.session.snapshot().auth);
  }

  private async getRemoteClient(
    auth: Extract<ChatgptAppsResolvedAuth, { status: "ok" }>,
  ): Promise<RemoteCodexAppsClient> {
    const authKey = `${auth.accountId}:${auth.accessToken}`;
    if (this.remoteClientState?.authKey === authKey) {
      return this.remoteClientState.client;
    }
    if (this.remoteClientPromise) {
      return await this.remoteClientPromise;
    }

    const previous = this.remoteClientState;
    this.remoteClientState = null;
    this.remoteClientPromise = this.remoteClientFactory({
      chatgptBaseUrl: this.config.chatgptBaseUrl,
      auth: {
        accessToken: auth.accessToken,
        accountId: auth.accountId,
      },
    });
    try {
      const client = await this.remoteClientPromise;
      if (previous) {
        await previous.client.close();
      }
      this.remoteClientState = {
        authKey,
        client,
      };
      return client;
    } finally {
      this.remoteClientPromise = null;
    }
  }

  private async getToolCache(): Promise<BridgeToolCache> {
    if (this.toolCachePromise) {
      return await this.toolCachePromise;
    }

    this.toolCachePromise = this.buildToolCache();
    try {
      this.toolCache = await this.toolCachePromise;
      return this.toolCache;
    } finally {
      this.toolCachePromise = null;
    }
  }

  private async buildToolCache(): Promise<BridgeToolCache> {
    const state = await this.captureBridgeState();
    if (
      this.toolCache &&
      this.toolCache.authKey === state.authKey &&
      this.toolCache.inventoryKey === state.inventoryKey
    ) {
      return this.toolCache;
    }

    return await this.buildToolCacheFromState(state);
  }

  private async captureBridgeState(): Promise<BridgeSnapshotState> {
    const lease = await this.getLease();
    const inventory = await lease.session.refreshInventory({ forceRefetch: false });
    const statuses = await lease.session.listMcpServerStatus();
    const auth = resolveBridgeAuth(lease.session.snapshot().auth);
    return {
      auth,
      inventory,
      statuses,
      authKey: `${auth.accountId}:${auth.accessToken}`,
      inventoryKey: buildInventoryKey({ inventory, statuses }),
    };
  }

  private async buildToolCacheFromState(state: BridgeSnapshotState): Promise<BridgeToolCache> {
    const allowedConnectorIds = buildAllowedConnectorIds({
      inventory: state.inventory,
      configuredConnectors: this.config.connectors,
    });
    const remoteToolConnectorMap = buildRemoteToolConnectorMap({
      statuses: state.statuses,
      allowedConnectorIds,
    });
    const routes = new Map<string, BridgeRoute>();
    const tools: Tool[] = [];

    if (allowedConnectorIds.size === 0) {
      return {
        authKey: state.authKey,
        inventoryKey: state.inventoryKey,
        tools,
        routes,
      };
    }

    const remoteTools = state.statuses.flatMap((status) =>
      Object.entries(status.tools ?? {}).flatMap(([, tool]) => (tool ? [tool] : [])),
    );

    for (const tool of remoteTools) {
      const connectorId = remoteToolConnectorMap.get(tool.name);
      if (!connectorId) {
        continue;
      }

      const route = {
        connectorId,
        remoteName: tool.name,
      };
      const rewritten = withRoutingMetadata(tool, route);
      tools.push(rewritten);
      routes.set(rewritten.name, route);
    }

    return {
      authKey: state.authKey,
      inventoryKey: state.inventoryKey,
      tools,
      routes,
    };
  }
}

export function createChatgptAppsManagedMcpServer(
  api: Pick<OpenClawPluginApi, "pluginConfig" | "rootDir">,
): OpenClawPluginManagedMcpServer | null {
  const config = resolveChatgptAppsConfig(api.pluginConfig);
  if (!config.enabled) {
    return null;
  }

  const entrypoint = path.resolve(api.rootDir ?? process.cwd(), "..", "..", "openclaw.mjs");
  return {
    name: MANAGED_MCP_SERVER_NAME,
    config: (ctx) => ({
      command: process.execPath,
      args: [entrypoint, "mcp", "openai-chatgpt-apps"],
      cwd: ctx.workspaceDir,
    }),
  };
}

export async function runChatgptAppsMcpBridgeStdio(params: {
  stateDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  pluginConfig: unknown;
  env?: NodeJS.ProcessEnv;
  acquireLease?: AcquireBridgeLease;
  remoteClientFactory?: RemoteCodexAppsClientFactory;
}): Promise<void> {
  const bridge = new ChatgptAppsMcpBridge(params);
  await bridge.connect(new StdioServerTransport());
}
