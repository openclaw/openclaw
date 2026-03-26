import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatgptAppsRpcClient } from "./app-server-supervisor.js";

const authProjectorMocks = vi.hoisted(() => ({
  resolveChatgptAppsProjectedAuth: vi.fn(),
}));

vi.mock("./auth-projector.js", () => ({
  resolveChatgptAppsProjectedAuth: authProjectorMocks.resolveChatgptAppsProjectedAuth,
}));

import { inspectChatgptApps } from "./inspect.js";

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

class FakeRpcClient implements ChatgptAppsRpcClient {
  initializeSession = vi.fn(async () => undefined);
  onNotification = vi.fn(() => () => {});
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
  listApps = vi
    .fn()
    .mockResolvedValueOnce({
      data: [
        {
          id: "gmail",
          name: "Gmail",
          description: null,
          logoUrl: null,
          logoUrlDark: null,
          distributionChannel: null,
          branding: null,
          appMetadata: null,
          labels: null,
          installUrl: "https://chatgpt.com/gmail",
          isAccessible: true,
          isEnabled: false,
          pluginDisplayNames: ["Gmail"],
        },
      ],
      nextCursor: "next-page",
    })
    .mockResolvedValueOnce({
      data: [
        {
          id: "google_drive",
          name: "Google Drive",
          description: null,
          logoUrl: null,
          logoUrlDark: null,
          distributionChannel: null,
          branding: null,
          appMetadata: null,
          labels: null,
          installUrl: "https://chatgpt.com/google-drive",
          isAccessible: false,
          isEnabled: true,
          pluginDisplayNames: ["Google Drive"],
        },
      ],
      nextCursor: null,
    });
  listMcpServerStatus = vi.fn(async () => ({
    data: [
      {
        name: "gmail",
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: "oAuth" as const,
      },
    ],
    nextCursor: null,
  }));
  close = vi.fn(async () => undefined);
}

class DerivedConfigAwareRpcClient implements ChatgptAppsRpcClient {
  private appsConfig: Record<string, boolean> = {};

  initializeSession = vi.fn(async () => undefined);
  onNotification = vi.fn(() => () => {});
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
  writeConfigValue = vi.fn(async (params) => {
    const nextAppsConfig: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(params.value as Record<string, unknown>)) {
      if (key === "_default" || !value || typeof value !== "object") {
        continue;
      }
      const enabled =
        "enabled" in value && typeof value.enabled === "boolean" ? value.enabled : false;
      nextAppsConfig[key] = enabled;
    }
    this.appsConfig = nextAppsConfig;
    return {
      status: "ok" as const,
      filePath: "/tmp/config.toml",
      version: "1",
      overriddenMetadata: null,
    };
  });
  listApps = vi.fn(async () => ({
    data: Object.entries(this.appsConfig)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, enabled]) =>
        createAppInfo({
          id,
          name: id === "gmail" ? "Gmail" : "Google Drive",
          isAccessible: true,
          isEnabled: enabled,
        }),
      ),
    nextCursor: null,
  }));
  listMcpServerStatus = vi.fn(async () => ({
    data: [],
    nextCursor: null,
  }));
  close = vi.fn(async () => undefined);
}

describe("inspectChatgptApps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a disabled report without starting the sidecar", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-disabled-"));
    const clientFactory = vi.fn();

    const report = await inspectChatgptApps({
      config: {} as never,
      pluginConfig: {},
      stateDir,
      clientFactory: clientFactory as never,
    });

    expect(report.enabled).toBe(false);
    expect(report.sidecar.status).toBe("disabled");
    expect(report.auth.status).toBe("disabled");
    expect(report.inventory.status).toBe("disabled");
    expect(report.diagnostics).toEqual([
      {
        scope: "sidecar",
        status: "disabled",
        message: "ChatGPT apps are disabled in OpenClaw config.",
      },
      {
        scope: "auth",
        status: "disabled",
        message: "ChatGPT apps are disabled in OpenClaw config.",
      },
      {
        scope: "inventory",
        status: "disabled",
        message: "ChatGPT apps are disabled in OpenClaw config.",
      },
      {
        scope: "remote-mcp",
        status: "disabled",
        message: "ChatGPT apps are disabled in OpenClaw config.",
      },
    ]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("projects auth, writes derived app config, and paginates inventory through the sidecar", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-enabled-"));
    await mkdir(stateDir, { recursive: true });
    const client = new FakeRpcClient();

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

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: {
                  enabled: true,
                  connectors: {
                    gmail: { enabled: false },
                    google_drive: { enabled: true },
                  },
                },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          connectors: {
            gmail: { enabled: false },
            google_drive: { enabled: true },
          },
        },
      },
      stateDir,
      clientFactory: vi.fn(async () => client),
    });

    expect(client.initializeSession).toHaveBeenCalledOnce();
    expect(client.loginAccount).toHaveBeenCalledOnce();
    expect(client.writeConfigValue).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPath: "apps",
        mergeStrategy: "replace",
        value: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
          gmail: {
            enabled: false,
          },
          google_drive: {
            enabled: true,
          },
        },
      }),
    );
    expect(report.sidecar.status).toBe("ready");
    expect(report.auth.status).toBe("ready");
    expect(report.auth.accountId).toBe("acct-123");
    expect(report.auth.email).toBe("owner@example.com");
    expect(report.auth.projectedEmail).toBe("user@example.com");
    expect(report.inventory.status).toBe("ready");
    expect(report.inventory.total).toBe(2);
    expect(report.inventory.accessible).toBe(1);
    expect(report.inventory.enabled).toBe(1);
    expect(report.inventory.apps.map((app) => app.id)).toEqual(["gmail", "google_drive"]);
    expect(report.mcpServers.status).toBe("ready");
    expect(report.mcpServers.servers).toEqual([
      {
        name: "gmail",
        authStatus: "oAuth",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
      },
    ]);
  });

  it("reports missing-auth diagnostics when OpenClaw has no projected auth", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-missing-auth-"));
    const client = new FakeRpcClient();

    authProjectorMocks.resolveChatgptAppsProjectedAuth.mockResolvedValue({
      status: "missing-auth",
      message: "OpenAI Codex OAuth is not configured in OpenClaw.",
    });

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: { enabled: true },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: { enabled: true },
      },
      stateDir,
      clientFactory: vi.fn(async () => client),
    });

    expect(report.sidecar.status).toBe("ready");
    expect(report.auth).toMatchObject({
      status: "missing-auth",
      message: "OpenAI Codex OAuth is not configured in OpenClaw.",
    });
    expect(report.inventory).toMatchObject({
      status: "error",
      message: "OpenAI Codex OAuth is not configured in OpenClaw.",
    });
    expect(report.mcpServers.status).toBe("disabled");
    expect(report.diagnostics).toContainEqual({
      scope: "auth",
      status: "error",
      message: "OpenAI Codex OAuth is not configured in OpenClaw.",
    });
    expect(report.diagnostics).toContainEqual({
      scope: "inventory",
      status: "error",
      message: "OpenAI Codex OAuth is not configured in OpenClaw.",
    });
    expect(client.loginAccount).not.toHaveBeenCalled();
  });

  it("reports missing-account-id diagnostics when projected auth lacks a ChatGPT account id", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-missing-account-"));
    const client = new FakeRpcClient();

    authProjectorMocks.resolveChatgptAppsProjectedAuth.mockResolvedValue({
      status: "missing-account-id",
      message: "Re-login with openai-codex before enabling ChatGPT apps.",
      accessToken: "access-token",
      identity: {
        email: "owner@example.com",
        profileName: "owner@example.com",
      },
    });

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: { enabled: true },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: { enabled: true },
      },
      stateDir,
      clientFactory: vi.fn(async () => client),
    });

    expect(report.auth).toMatchObject({
      status: "missing-account-id",
      message: "Re-login with openai-codex before enabling ChatGPT apps.",
      email: "owner@example.com",
    });
    expect(report.inventory).toMatchObject({
      status: "error",
      message: "Re-login with openai-codex before enabling ChatGPT apps.",
    });
    expect(client.loginAccount).not.toHaveBeenCalled();
  });

  it("reports sidecar startup errors when the Codex app-server cannot be spawned", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-sidecar-error-"));

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

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: { enabled: true },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: { enabled: true },
      },
      stateDir,
      clientFactory: vi.fn(async () => {
        throw new Error("codex app-server unavailable");
      }),
    });

    expect(report.sidecar).toMatchObject({
      status: "error",
      message: "codex app-server unavailable",
    });
    expect(report.inventory).toMatchObject({
      status: "error",
      message: "codex app-server unavailable",
    });
    expect(report.diagnostics).toContainEqual({
      scope: "sidecar",
      status: "error",
      message: "codex app-server unavailable",
    });
  });

  it("reports an empty inventory when the sidecar returns no accessible apps", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-empty-"));
    const client = new FakeRpcClient();
    client.listApps = vi.fn(async () => ({
      data: [],
      nextCursor: null,
    }));
    client.listMcpServerStatus = vi.fn(async () => ({
      data: [],
      nextCursor: null,
    }));

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

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: { enabled: true },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: { enabled: true },
      },
      stateDir,
      clientFactory: vi.fn(async () => client),
    });

    expect(report.inventory).toMatchObject({
      status: "empty",
      message: "The Codex app-server reported no accessible ChatGPT apps for the current account.",
      total: 0,
    });
  });

  it("classifies remote MCP failures separately from sidecar and inventory failures", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-remote-mcp-"));
    const client = new FakeRpcClient();
    client.listMcpServerStatus = vi.fn(async () => {
      throw new Error("remote MCP status unavailable");
    });

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

    const report = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: { enabled: true },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: { enabled: true },
      },
      stateDir,
      clientFactory: vi.fn(async () => client),
    });

    expect(report.sidecar.status).toBe("ready");
    expect(report.inventory.status).toBe("ready");
    expect(report.mcpServers).toMatchObject({
      status: "error",
      message: "remote MCP status unavailable",
    });
    expect(report.diagnostics).toContainEqual({
      scope: "remote-mcp",
      status: "error",
      message: "remote MCP status unavailable",
    });
  });

  it("updates AppInfo.isEnabled in the next snapshot when OpenClaw connector config changes", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openai-chatgpt-apps-enabled-flip-"));

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

    const firstClient = new DerivedConfigAwareRpcClient();
    const firstReport = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: {
                  enabled: true,
                  connectors: {
                    gmail: { enabled: false },
                  },
                },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          connectors: {
            gmail: { enabled: false },
          },
        },
      },
      stateDir,
      clientFactory: vi.fn(async () => firstClient),
    });

    const secondClient = new DerivedConfigAwareRpcClient();
    const secondReport = await inspectChatgptApps({
      config: {
        plugins: {
          entries: {
            openai: {
              config: {
                chatgptApps: {
                  enabled: true,
                  connectors: {
                    gmail: { enabled: true },
                  },
                },
              },
            },
          },
        },
      } as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          connectors: {
            gmail: { enabled: true },
          },
        },
      },
      stateDir,
      clientFactory: vi.fn(async () => secondClient),
    });

    expect(firstReport.inventory.apps).toEqual([
      expect.objectContaining({
        id: "gmail",
        isEnabled: false,
      }),
    ]);
    expect(secondReport.inventory.apps).toEqual([
      expect.objectContaining({
        id: "gmail",
        isEnabled: true,
      }),
    ]);
  });
});
