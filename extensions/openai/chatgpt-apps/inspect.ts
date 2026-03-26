import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  acquireChatgptAppsSidecarSession,
  resolveChatgptAppsSessionLayout,
  type ChatgptAppsClientFactory,
} from "./app-server-supervisor.js";
import { resolveChatgptAppsConfig } from "./config.js";

export type ChatgptAppsInspection = {
  diagnostics: Array<{
    scope: "sidecar" | "auth" | "inventory" | "remote-mcp";
    status: "ok" | "error" | "disabled";
    message: string;
  }>;
  enabled: boolean;
  layout: ReturnType<typeof resolveChatgptAppsSessionLayout>;
  config: {
    chatgptBaseUrl: string;
    appServer: {
      command: string;
      args: string[];
    };
    connectors: Array<{
      id: string;
      enabled: boolean;
    }>;
  };
  sidecar: {
    status: "disabled" | "ready" | "error";
    message: string | null;
  };
  auth: {
    status: "disabled" | "missing-auth" | "missing-account-id" | "ready" | "error";
    message: string | null;
    accountId: string | null;
    email: string | null;
    profileName: string | null;
    projectedEmail: string | null;
    planType: string | null;
    requiresOpenaiAuth: boolean | null;
  };
  inventory: {
    status: "disabled" | "ready" | "empty" | "error";
    message: string | null;
    total: number;
    accessible: number;
    enabled: number;
    source: "rpc" | "notification" | null;
    updatedAt: string | null;
    apps: Array<{
      id: string;
      name: string;
      isAccessible: boolean;
      isEnabled: boolean;
      installUrl: string | null;
      pluginDisplayNames: string[];
    }>;
  };
  mcpServers: {
    status: "disabled" | "ready" | "error";
    message: string | null;
    servers: Array<{
      name: string;
      authStatus: string;
      toolCount: number;
      resourceCount: number;
      resourceTemplateCount: number;
    }>;
  };
};

function buildInspectionDiagnostics(
  inspection: Pick<ChatgptAppsInspection, "sidecar" | "auth" | "inventory" | "mcpServers">,
): ChatgptAppsInspection["diagnostics"] {
  const diagnostics: ChatgptAppsInspection["diagnostics"] = [
    {
      scope: "sidecar",
      status: inspection.sidecar.status === "ready" ? "ok" : inspection.sidecar.status,
      message:
        inspection.sidecar.message ??
        (inspection.sidecar.status === "ready"
          ? "Codex app-server sidecar started successfully."
          : "ChatGPT apps sidecar is unavailable."),
    },
    {
      scope: "auth",
      status:
        inspection.auth.status === "ready"
          ? "ok"
          : inspection.auth.status === "disabled"
            ? "disabled"
            : "error",
      message:
        inspection.auth.message ??
        (inspection.auth.status === "ready"
          ? `OpenAI Codex OAuth projection is ready${
              inspection.auth.accountId ? ` for ChatGPT account ${inspection.auth.accountId}` : ""
            }.`
          : "ChatGPT apps auth projection is unavailable."),
    },
  ];

  diagnostics.push({
    scope: "inventory",
    status:
      inspection.inventory.status === "error"
        ? "error"
        : inspection.inventory.status === "disabled"
          ? "disabled"
          : "ok",
    message:
      inspection.inventory.message ??
      `Loaded ${inspection.inventory.total} app(s); ${inspection.inventory.accessible} accessible and ${inspection.inventory.enabled} enabled locally.`,
  });

  diagnostics.push({
    scope: "remote-mcp",
    status: inspection.mcpServers.status === "ready" ? "ok" : inspection.mcpServers.status,
    message:
      inspection.mcpServers.message ??
      `Read ${inspection.mcpServers.servers.length} remote MCP server status entr${
        inspection.mcpServers.servers.length === 1 ? "y" : "ies"
      }.`,
  });

  return diagnostics;
}

function emptyInspection(params: {
  enabled: boolean;
  layout: ReturnType<typeof resolveChatgptAppsSessionLayout>;
  config: ReturnType<typeof resolveChatgptAppsConfig>;
}): ChatgptAppsInspection {
  return {
    diagnostics: [],
    enabled: params.enabled,
    layout: params.layout,
    config: {
      chatgptBaseUrl: params.config.chatgptBaseUrl,
      appServer: {
        command: params.config.appServer.command,
        args: [...params.config.appServer.args],
      },
      connectors: Object.entries(params.config.connectors)
        .map(([id, entry]) => ({
          id,
          enabled: entry.enabled,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    },
    sidecar: {
      status: params.enabled ? "error" : "disabled",
      message: params.enabled
        ? "ChatGPT apps inspection has not run yet."
        : "ChatGPT apps are disabled in OpenClaw config.",
    },
    auth: {
      status: params.enabled ? "error" : "disabled",
      message: params.enabled
        ? "ChatGPT apps inspection has not run yet."
        : "ChatGPT apps are disabled in OpenClaw config.",
      accountId: null,
      email: null,
      profileName: null,
      projectedEmail: null,
      planType: null,
      requiresOpenaiAuth: null,
    },
    inventory: {
      status: params.enabled ? "error" : "disabled",
      message: params.enabled
        ? "ChatGPT apps inspection has not run yet."
        : "ChatGPT apps are disabled in OpenClaw config.",
      total: 0,
      accessible: 0,
      enabled: 0,
      source: null,
      updatedAt: null,
      apps: [],
    },
    mcpServers: {
      status: params.enabled ? "error" : "disabled",
      message: params.enabled
        ? "ChatGPT apps inspection has not run yet."
        : "ChatGPT apps are disabled in OpenClaw config.",
      servers: [],
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function inspectChatgptApps(params: {
  config: OpenClawConfig;
  pluginConfig: unknown;
  stateDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  clientFactory?: ChatgptAppsClientFactory;
  forceRefetch?: boolean;
}): Promise<ChatgptAppsInspection> {
  const config = resolveChatgptAppsConfig(params.pluginConfig);
  const layout = resolveChatgptAppsSessionLayout({
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    config,
  });
  const inspection = emptyInspection({
    enabled: config.enabled,
    layout,
    config,
  });

  if (!config.enabled) {
    inspection.diagnostics = buildInspectionDiagnostics(inspection);
    return inspection;
  }

  const lease = await acquireChatgptAppsSidecarSession({
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    config,
    openclawConfig: params.config,
    env: params.env,
    clientFactory: params.clientFactory,
  });

  try {
    let inventoryError: string | null = null;
    let mcpError: string | null = null;
    let mcpServers: Awaited<ReturnType<typeof lease.session.listMcpServerStatus>> = [];

    try {
      await lease.session.refreshInventory({
        forceRefetch: params.forceRefetch ?? false,
      });
    } catch (error) {
      inventoryError = toErrorMessage(error);
    }

    const snapshot = lease.session.snapshot();
    inspection.sidecar =
      snapshot.clientReady && !snapshot.sidecarError
        ? {
            status: "ready",
            message: null,
          }
        : {
            status: "error",
            message:
              snapshot.sidecarError ??
              inventoryError ??
              "Failed to start the Codex app-server sidecar.",
          };

    if (snapshot.auth?.status === "ok") {
      inspection.auth = {
        status: "ready",
        message: null,
        accountId: snapshot.auth.accountId,
        email: snapshot.auth.identity.email ?? null,
        profileName: snapshot.auth.identity.profileName ?? null,
        projectedEmail:
          snapshot.projectedAccount?.account?.type === "chatgpt"
            ? snapshot.projectedAccount.account.email
            : null,
        planType:
          snapshot.projectedAccount?.account?.type === "chatgpt"
            ? snapshot.projectedAccount.account.planType
            : null,
        requiresOpenaiAuth: snapshot.projectedAccount?.requiresOpenaiAuth ?? null,
      };
    } else if (snapshot.auth) {
      inspection.auth = {
        status: snapshot.auth.status,
        message: snapshot.auth.message,
        accountId: null,
        email: "identity" in snapshot.auth ? (snapshot.auth.identity.email ?? null) : null,
        profileName:
          "identity" in snapshot.auth ? (snapshot.auth.identity.profileName ?? null) : null,
        projectedEmail: null,
        planType: null,
        requiresOpenaiAuth: null,
      };
    }

    if (snapshot.auth?.status === "ok" && snapshot.clientReady) {
      try {
        mcpServers = await lease.session.listMcpServerStatus();
      } catch (error) {
        mcpError = toErrorMessage(error);
      }
    }

    if (snapshot.inventory) {
      inspection.inventory = {
        status: snapshot.inventory.apps.length > 0 ? "ready" : "empty",
        message:
          snapshot.inventory.apps.length > 0
            ? null
            : "The Codex app-server reported no accessible ChatGPT apps for the current account.",
        total: snapshot.inventory.apps.length,
        accessible: snapshot.inventory.apps.filter((app) => app.isAccessible).length,
        enabled: snapshot.inventory.apps.filter((app) => app.isEnabled).length,
        source: snapshot.inventory.source,
        updatedAt: snapshot.inventory.updatedAt,
        apps: snapshot.inventory.apps
          .map((app) => ({
            id: app.id,
            name: app.name,
            isAccessible: app.isAccessible,
            isEnabled: app.isEnabled,
            installUrl: app.installUrl,
            pluginDisplayNames: [...app.pluginDisplayNames],
          }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      };
    } else if (inventoryError) {
      inspection.inventory = {
        status: "error",
        message: inventoryError,
        total: 0,
        accessible: 0,
        enabled: 0,
        source: null,
        updatedAt: null,
        apps: [],
      };
    }

    if (snapshot.auth?.status !== "ok") {
      inspection.mcpServers = {
        status: "disabled",
        message: "MCP server status is unavailable until ChatGPT auth projection succeeds.",
        servers: [],
      };
    } else if (mcpError) {
      inspection.mcpServers = {
        status: "error",
        message: mcpError,
        servers: [],
      };
    } else {
      inspection.mcpServers = {
        status: "ready",
        message: null,
        servers: mcpServers
          .map((server) => ({
            name: server.name,
            authStatus: server.authStatus,
            toolCount: Object.keys(server.tools).length,
            resourceCount: server.resources.length,
            resourceTemplateCount: server.resourceTemplates.length,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      };
    }

    inspection.diagnostics = buildInspectionDiagnostics(inspection);
    return inspection;
  } finally {
    await lease.release();
  }
}
