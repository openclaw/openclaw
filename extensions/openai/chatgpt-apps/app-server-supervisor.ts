import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveChatgptAppsProjectedAuth, type ChatgptAppsResolvedAuth } from "./auth-projector.js";
import { CodexAppServerClient } from "./codex-sdk/client.js";
import type { GetAuthStatusResponse } from "./codex-sdk/generated/protocol/GetAuthStatusResponse.js";
import type { AppInfo } from "./codex-sdk/generated/protocol/v2/AppInfo.js";
import type { AppListUpdatedNotification } from "./codex-sdk/generated/protocol/v2/AppListUpdatedNotification.js";
import type { AppsListParams } from "./codex-sdk/generated/protocol/v2/AppsListParams.js";
import type { AppsListResponse } from "./codex-sdk/generated/protocol/v2/AppsListResponse.js";
import type { ChatgptAuthTokensRefreshParams } from "./codex-sdk/generated/protocol/v2/ChatgptAuthTokensRefreshParams.js";
import type { ChatgptAuthTokensRefreshResponse } from "./codex-sdk/generated/protocol/v2/ChatgptAuthTokensRefreshResponse.js";
import type { ConfigValueWriteParams } from "./codex-sdk/generated/protocol/v2/ConfigValueWriteParams.js";
import type { ConfigWriteResponse } from "./codex-sdk/generated/protocol/v2/ConfigWriteResponse.js";
import type { GetAccountParams } from "./codex-sdk/generated/protocol/v2/GetAccountParams.js";
import type { GetAccountResponse } from "./codex-sdk/generated/protocol/v2/GetAccountResponse.js";
import type { ListMcpServerStatusParams } from "./codex-sdk/generated/protocol/v2/ListMcpServerStatusParams.js";
import type { ListMcpServerStatusResponse } from "./codex-sdk/generated/protocol/v2/ListMcpServerStatusResponse.js";
import type { LoginAccountParams } from "./codex-sdk/generated/protocol/v2/LoginAccountParams.js";
import type { LoginAccountResponse } from "./codex-sdk/generated/protocol/v2/LoginAccountResponse.js";
import type { McpServerStatus } from "./codex-sdk/generated/protocol/v2/McpServerStatus.js";
import type { Unsubscribe } from "./codex-sdk/subscriptions.js";
import { buildDerivedAppsConfig, type ChatgptAppsConfig } from "./config.js";

type ChatgptAppsLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

type InventoryCache = {
  apps: AppInfo[];
  source: "rpc" | "notification";
  updatedAt: string;
};

type InventoryListener = (cache: InventoryCache) => void;

type ProjectedAccountSnapshot = {
  auth: ChatgptAppsResolvedAuth;
  account: GetAccountResponse["account"];
  requiresOpenaiAuth: boolean;
  authStatus: GetAuthStatusResponse;
  projectedAt: string;
};

export type ChatgptAppsRpcClient = {
  initializeSession(): Promise<unknown>;
  onNotification(
    method: "app/list/updated",
    listener: (notification: {
      method: "app/list/updated";
      params: AppListUpdatedNotification;
    }) => void,
  ): Unsubscribe;
  handleChatgptAuthTokensRefresh(
    handler: (
      params: ChatgptAuthTokensRefreshParams,
    ) => ChatgptAuthTokensRefreshResponse | Promise<ChatgptAuthTokensRefreshResponse>,
  ): Unsubscribe;
  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse>;
  readAccount(params: GetAccountParams): Promise<GetAccountResponse>;
  getAuthStatus(params: {
    includeToken: boolean | null;
    refreshToken: boolean | null;
  }): Promise<GetAuthStatusResponse>;
  listApps(params: AppsListParams): Promise<AppsListResponse>;
  listMcpServerStatus(params: ListMcpServerStatusParams): Promise<ListMcpServerStatusResponse>;
  writeConfigValue(params: ConfigValueWriteParams): Promise<ConfigWriteResponse>;
  close(): Promise<unknown>;
};

export type ChatgptAppsClientFactory = (params: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}) => Promise<ChatgptAppsRpcClient>;

export type ChatgptAppsSessionLayout = {
  sessionKey: string;
  sandboxDir: string;
  configFilePath: string;
};

export type ChatgptAppsSessionSnapshot = {
  layout: ChatgptAppsSessionLayout;
  clientReady: boolean;
  sidecarError: string | null;
  auth: ChatgptAppsResolvedAuth | null;
  projectedAccount: ProjectedAccountSnapshot | null;
  inventory: InventoryCache | null;
};

export type ChatgptAppsInventorySnapshot = InventoryCache;

function createNoopLogger(): ChatgptAppsLogger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function defaultClientFactory(params: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): Promise<ChatgptAppsRpcClient> {
  return CodexAppServerClient.spawn({
    bin: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    analyticsDefaultEnabled: true,
  }).then((client) => ({
    initializeSession: () => client.initializeSession(),
    onNotification: (method, listener) => client.onNotification(method, listener),
    handleChatgptAuthTokensRefresh: (handler) => client.handleChatgptAuthTokensRefresh(handler),
    loginAccount: (loginParams) => client.loginAccount(loginParams),
    readAccount: (readParams) => client.readAccount(readParams),
    getAuthStatus: (statusParams) => client.getAuthStatus(statusParams),
    listApps: (listParams) => client.listApps(listParams),
    listMcpServerStatus: (listParams) => client.listMcpServerStatus(listParams),
    writeConfigValue: (writeParams) => client.writeConfigValue(writeParams),
    close: async () => {
      await client.close();
    },
  }));
}

function toLoginParams(
  auth: Extract<ChatgptAppsResolvedAuth, { status: "ok" }>,
): LoginAccountParams {
  return {
    type: "chatgptAuthTokens",
    accessToken: auth.accessToken,
    chatgptAccountId: auth.accountId,
    chatgptPlanType: auth.planType,
  };
}

function resolveSessionHash(params: { workspaceDir?: string; config: ChatgptAppsConfig }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceDir: params.workspaceDir ?? null,
        command: params.config.appServer.command,
        args: params.config.appServer.args,
        chatgptBaseUrl: params.config.chatgptBaseUrl,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

export function resolveChatgptAppsSessionLayout(params: {
  stateDir: string;
  workspaceDir?: string;
  config: ChatgptAppsConfig;
}): ChatgptAppsSessionLayout {
  const sessionHash = resolveSessionHash({
    workspaceDir: params.workspaceDir,
    config: params.config,
  });
  const sandboxDir = path.join(params.stateDir, "openai", "chatgpt-apps", sessionHash);
  return {
    sessionKey: sandboxDir,
    sandboxDir,
    configFilePath: path.join(sandboxDir, "config.toml"),
  };
}

export class ChatgptAppsSidecarSession {
  readonly layout: ChatgptAppsSessionLayout;
  private readonly config: ChatgptAppsConfig;
  private readonly openclawConfig: OpenClawConfig;
  private readonly workspaceDir?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clientFactory: ChatgptAppsClientFactory;
  private readonly logger: ChatgptAppsLogger;
  private readonly now: () => number;
  private readonly inventoryListeners = new Set<InventoryListener>();
  private clientPromise: Promise<ChatgptAppsRpcClient> | null = null;
  private client: ChatgptAppsRpcClient | null = null;
  private readonly unsubscribers: Unsubscribe[] = [];
  private inventoryCache: InventoryCache | null = null;
  private projectedAccount: ProjectedAccountSnapshot | null = null;
  private authSnapshot: ChatgptAppsResolvedAuth | null = null;
  private derivedAppsConfigKey: string | null = null;
  private sidecarError: string | null = null;

  constructor(params: {
    stateDir: string;
    workspaceDir?: string;
    config: ChatgptAppsConfig;
    openclawConfig: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    clientFactory?: ChatgptAppsClientFactory;
    logger?: ChatgptAppsLogger;
    now?: () => number;
  }) {
    this.layout = resolveChatgptAppsSessionLayout({
      stateDir: params.stateDir,
      workspaceDir: params.workspaceDir,
      config: params.config,
    });
    this.config = params.config;
    this.openclawConfig = params.openclawConfig;
    this.workspaceDir = params.workspaceDir;
    this.env = params.env ?? process.env;
    this.clientFactory = params.clientFactory ?? defaultClientFactory;
    this.logger = params.logger ?? createNoopLogger();
    this.now = params.now ?? Date.now;
  }

  async warm(): Promise<void> {
    await this.refreshInventory({ forceRefetch: false });
  }

  async refreshInventory(params: { forceRefetch: boolean }): Promise<AppInfo[]> {
    const client = await this.getClient();
    await this.ensureProjectedAuth(client);
    await this.syncDerivedAppsConfig(client);
    if (this.inventoryCache && !params.forceRefetch) {
      return this.inventoryCache.apps;
    }

    const apps: AppInfo[] = [];
    let cursor: string | null = null;

    do {
      const response = await client.listApps({
        cursor,
        forceRefetch: params.forceRefetch,
      });
      apps.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);

    this.setInventoryCache({
      apps,
      source: "rpc",
      updatedAt: new Date(this.now()).toISOString(),
    });
    return apps;
  }

  async listMcpServerStatus(): Promise<McpServerStatus[]> {
    const client = await this.getClient();
    await this.ensureProjectedAuth(client);

    const servers: McpServerStatus[] = [];
    let cursor: string | null = null;

    do {
      const response = await client.listMcpServerStatus({
        cursor,
      });
      servers.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);

    return servers;
  }

  snapshot(): ChatgptAppsSessionSnapshot {
    return {
      layout: this.layout,
      clientReady: this.client !== null,
      sidecarError: this.sidecarError,
      auth: this.authSnapshot,
      projectedAccount: this.projectedAccount,
      inventory: this.inventoryCache,
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    this.sidecarError = null;
    if (client) {
      await client.close();
    }
  }

  onInventoryUpdate(listener: InventoryListener): Unsubscribe {
    this.inventoryListeners.add(listener);
    return () => {
      this.inventoryListeners.delete(listener);
    };
  }

  private async getClient(): Promise<ChatgptAppsRpcClient> {
    if (this.client) {
      return this.client;
    }
    if (this.clientPromise) {
      return await this.clientPromise;
    }

    this.clientPromise = this.createClient();
    try {
      this.client = await this.clientPromise;
      this.sidecarError = null;
      return this.client;
    } catch (error) {
      this.clientPromise = null;
      this.sidecarError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async createClient(): Promise<ChatgptAppsRpcClient> {
    await mkdir(this.layout.sandboxDir, { recursive: true });
    this.logger.debug?.(`openai chatgpt-apps: starting sidecar in ${this.layout.sandboxDir}`);

    const client = await this.clientFactory({
      command: this.config.appServer.command,
      args: this.config.appServer.args,
      cwd: this.workspaceDir,
      env: {
        ...this.env,
        CODEX_HOME: this.layout.sandboxDir,
      },
    });

    await client.initializeSession();

    this.unsubscribers.push(
      client.onNotification("app/list/updated", (notification) => {
        this.setInventoryCache({
          apps: notification.params.data,
          source: "notification",
          updatedAt: new Date(this.now()).toISOString(),
        });
      }),
    );
    this.unsubscribers.push(
      client.handleChatgptAuthTokensRefresh(async () => await this.resolveRefreshResponse()),
    );

    return client;
  }

  private async ensureProjectedAuth(client: ChatgptAppsRpcClient): Promise<void> {
    const auth = await resolveChatgptAppsProjectedAuth({
      config: this.openclawConfig,
      env: this.env,
    });
    this.authSnapshot = auth;

    if (auth.status !== "ok") {
      this.projectedAccount = null;
      throw new Error(auth.message);
    }

    if (
      this.projectedAccount &&
      this.projectedAccount.auth.status === "ok" &&
      this.projectedAccount.auth.accountId === auth.accountId &&
      this.projectedAccount.auth.accessToken === auth.accessToken
    ) {
      return;
    }

    await client.loginAccount(toLoginParams(auth));
    const [accountResponse, authStatus] = await Promise.all([
      client.readAccount({ refreshToken: false }),
      client.getAuthStatus({ includeToken: false, refreshToken: false }),
    ]);

    this.projectedAccount = {
      auth,
      account: accountResponse.account,
      requiresOpenaiAuth: accountResponse.requiresOpenaiAuth,
      authStatus,
      projectedAt: new Date(this.now()).toISOString(),
    };
  }

  private async syncDerivedAppsConfig(client: ChatgptAppsRpcClient): Promise<void> {
    const value = buildDerivedAppsConfig(this.config);
    const serialized = JSON.stringify(value);
    if (serialized === this.derivedAppsConfigKey) {
      return;
    }

    await client.writeConfigValue({
      keyPath: "apps",
      value,
      mergeStrategy: "replace",
      filePath: this.layout.configFilePath,
      expectedVersion: null,
    });
    this.derivedAppsConfigKey = serialized;
  }

  private async resolveRefreshResponse(): Promise<ChatgptAuthTokensRefreshResponse> {
    const auth = await resolveChatgptAppsProjectedAuth({
      config: this.openclawConfig,
      env: this.env,
    });
    this.authSnapshot = auth;
    if (auth.status !== "ok") {
      throw new Error(auth.message);
    }
    return {
      accessToken: auth.accessToken,
      chatgptAccountId: auth.accountId,
      chatgptPlanType: auth.planType,
    };
  }

  private setInventoryCache(cache: InventoryCache): void {
    this.inventoryCache = cache;
    for (const listener of this.inventoryListeners) {
      listener(cache);
    }
  }
}

type SessionEntry = {
  refs: number;
  session: ChatgptAppsSidecarSession;
};

const sessionRegistry = new Map<string, SessionEntry>();

export async function acquireChatgptAppsSidecarSession(params: {
  stateDir: string;
  workspaceDir?: string;
  config: ChatgptAppsConfig;
  openclawConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clientFactory?: ChatgptAppsClientFactory;
  logger?: ReturnType<typeof createNoopLogger>;
}): Promise<{
  session: ChatgptAppsSidecarSession;
  release: () => Promise<void>;
}> {
  const layout = resolveChatgptAppsSessionLayout({
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    config: params.config,
  });
  let entry = sessionRegistry.get(layout.sessionKey);
  if (!entry) {
    entry = {
      refs: 0,
      session: new ChatgptAppsSidecarSession({
        stateDir: params.stateDir,
        workspaceDir: params.workspaceDir,
        config: params.config,
        openclawConfig: params.openclawConfig,
        env: params.env,
        clientFactory: params.clientFactory,
        logger: params.logger,
      }),
    };
    sessionRegistry.set(layout.sessionKey, entry);
  }

  entry.refs += 1;
  let released = false;

  return {
    session: entry.session,
    release: async () => {
      if (released) {
        return;
      }
      released = true;

      const current = sessionRegistry.get(layout.sessionKey);
      if (!current) {
        return;
      }
      current.refs -= 1;
      if (current.refs > 0) {
        return;
      }
      sessionRegistry.delete(layout.sessionKey);
      await current.session.close();
    },
  };
}
