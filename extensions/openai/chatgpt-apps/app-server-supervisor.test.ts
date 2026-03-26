import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatgptAppsRpcClient } from "./app-server-supervisor.js";

const authProjectorMocks = vi.hoisted(() => ({
  resolveChatgptAppsProjectedAuth: vi.fn(),
}));

vi.mock("./auth-projector.js", () => ({
  resolveChatgptAppsProjectedAuth: authProjectorMocks.resolveChatgptAppsProjectedAuth,
}));

import { ChatgptAppsSidecarSession } from "./app-server-supervisor.js";

function createAppInfo(params: {
  id: string;
  name: string;
  isAccessible: boolean;
  isEnabled: boolean;
}) {
  return {
    id: params.id,
    name: params.name,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: `https://chatgpt.com/${params.id}`,
    isAccessible: params.isAccessible,
    isEnabled: params.isEnabled,
    pluginDisplayNames: [params.name],
  };
}

class NotificationAwareRpcClient implements ChatgptAppsRpcClient {
  private appListUpdatedListener:
    | ((notification: {
        method: "app/list/updated";
        params: { data: ReturnType<typeof createAppInfo>[] };
      }) => void)
    | null = null;

  initializeSession = vi.fn(async () => undefined);
  onNotification = vi.fn((method, listener) => {
    if (method === "app/list/updated") {
      this.appListUpdatedListener = listener as typeof this.appListUpdatedListener;
    }
    return () => {
      this.appListUpdatedListener = null;
    };
  });
  handleChatgptAuthTokensRefresh = vi.fn(() => () => {});
  loginAccount = vi.fn(async () => ({ type: "chatgptAuthTokens" as const }));
  readAccount = vi.fn(async () => ({
    account: {
      type: "chatgpt" as const,
      email: "user@example.com",
      planType: "plus" as const,
    },
    requiresOpenaiAuth: false,
  }));
  getAuthStatus = vi.fn(async () => ({
    authMethod: "chatgptAuthTokens" as const,
    authToken: null,
    requiresOpenaiAuth: false,
  }));
  writeConfigValue = vi.fn(async () => ({
    status: "ok" as const,
    filePath: "/tmp/config.toml",
    version: "1",
    overriddenMetadata: null,
  }));
  listApps = vi.fn(async () => ({
    data: [
      createAppInfo({
        id: "gmail",
        name: "Gmail",
        isAccessible: true,
        isEnabled: true,
      }),
    ],
    nextCursor: null,
  }));
  listMcpServerStatus = vi.fn(async () => ({
    data: [],
    nextCursor: null,
  }));
  close = vi.fn(async () => undefined);

  emitAppListUpdated(apps: ReturnType<typeof createAppInfo>[]) {
    this.appListUpdatedListener?.({
      method: "app/list/updated",
      params: {
        data: apps,
      },
    });
  }
}

describe("ChatgptAppsSidecarSession", () => {
  it("replaces the cached inventory when app/list/updated arrives", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-session-"));
    const client = new NotificationAwareRpcClient();

    authProjectorMocks.resolveChatgptAppsProjectedAuth.mockResolvedValue({
      status: "ok",
      accessToken: "access-token",
      accountId: "acct-123",
      planType: null,
      identity: {
        email: "owner@example.com",
        profileName: "owner@example.com",
      },
    });

    const session = new ChatgptAppsSidecarSession({
      stateDir,
      config: {
        enabled: true,
        chatgptBaseUrl: "https://chatgpt.com",
        appServer: {
          command: "codex",
          args: [],
        },
        linking: {
          enabled: false,
          waitTimeoutMs: 60_000,
          pollIntervalMs: 3_000,
        },
        connectors: {
          gmail: { enabled: true },
        },
      },
      openclawConfig: {} as never,
      clientFactory: vi.fn(async () => client),
      now: () => 0,
    });

    await session.refreshInventory({ forceRefetch: false });
    client.emitAppListUpdated([
      createAppInfo({
        id: "google_drive",
        name: "Google Drive",
        isAccessible: true,
        isEnabled: true,
      }),
    ]);

    expect(session.snapshot().inventory).toEqual({
      apps: [
        expect.objectContaining({
          id: "google_drive",
        }),
      ],
      source: "notification",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    await expect(session.refreshInventory({ forceRefetch: false })).resolves.toEqual([
      expect.objectContaining({
        id: "google_drive",
      }),
    ]);
    expect(client.listApps).toHaveBeenCalledOnce();

    await session.close();
  });
});
