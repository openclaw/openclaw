import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "./codex-sdk/generated/protocol/v2/AppInfo.js";
import { ChatgptAppsMcpBridge, deriveChatgptAppsMcpUrl } from "./index.js";

function createApp(params: {
  id: string;
  name: string;
  isAccessible: boolean;
  isEnabled: boolean;
}): AppInfo {
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
    installUrl: null,
    isAccessible: params.isAccessible,
    isEnabled: params.isEnabled,
    pluginDisplayNames: [params.name],
  };
}

describe("deriveChatgptAppsMcpUrl", () => {
  it("matches the Codex apps endpoint derivation rules", () => {
    expect(deriveChatgptAppsMcpUrl("https://chatgpt.com")).toBe(
      "https://chatgpt.com/backend-api/wham/apps",
    );
    expect(deriveChatgptAppsMcpUrl("https://chat.openai.com")).toBe(
      "https://chat.openai.com/backend-api/wham/apps",
    );
    expect(deriveChatgptAppsMcpUrl("https://example.com/api/codex")).toBe(
      "https://example.com/api/codex/apps",
    );
    expect(deriveChatgptAppsMcpUrl("https://example.com/custom-base")).toBe(
      "https://example.com/custom-base/api/codex/apps",
    );
  });
});

describe("ChatgptAppsMcpBridge", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map(async (dispose) => await dispose()));
  });

  it("exposes only accessible and enabled connector tools and forwards calls", async () => {
    const release = vi.fn(async () => undefined);
    const inventoryListeners = new Set<(snapshot: { apps: AppInfo[] }) => void>();
    const remoteClient = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: undefined })),
      listAllTools: vi.fn(async () => [
        {
          name: "gmail_search",
          description: "Search Gmail",
          inputSchema: { type: "object" as const },
        },
        {
          name: "drive_search",
          description: "Search Drive",
          inputSchema: { type: "object" as const },
        },
      ]),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "gmail-ok" }],
      })),
      close: vi.fn(async () => undefined),
    };
    const bridge = new ChatgptAppsMcpBridge({
      stateDir: "/tmp/openclaw-chatgpt-apps-test",
      workspaceDir: "/tmp/openclaw-chatgpt-apps-test/workspace",
      config: {} as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
        },
      },
      acquireLease: (async () => ({
        session: {
          refreshInventory: async () => [
            createApp({
              id: "gmail",
              name: "Gmail",
              isAccessible: true,
              isEnabled: true,
            }),
            createApp({
              id: "drive",
              name: "Google Drive",
              isAccessible: true,
              isEnabled: false,
            }),
          ],
          listMcpServerStatus: async () => [
            {
              name: "gmail",
              tools: {
                gmail_search: {
                  name: "gmail_search",
                  description: "Search Gmail",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "oAuth",
            },
            {
              name: "drive",
              tools: {
                drive_search: {
                  name: "drive_search",
                  description: "Search Drive",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "oAuth",
            },
          ],
          onInventoryUpdate: (listener: (snapshot: { apps: AppInfo[] }) => void) => {
            inventoryListeners.add(listener);
            return () => {
              inventoryListeners.delete(listener);
            };
          },
          snapshot: () => ({
            auth: {
              status: "ok" as const,
              accessToken: "token-1",
              accountId: "acct-1",
              planType: "plus" as const,
              identity: {
                chatgptUserId: "user-1",
                accountId: "acct-1",
                isWorkspaceAccount: false,
              },
            },
          }),
        },
        release,
      })) as never,
      remoteClientFactory: vi.fn(async () => remoteClient),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "1.0.0" });

    disposers.push(async () => {
      await client.close();
    });
    disposers.push(async () => {
      await bridge.close();
    });

    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name)).toEqual([
      "chatgpt_app__gmail__gmail_search",
    ]);

    const result = await client.callTool({
      name: "chatgpt_app__gmail__gmail_search",
      arguments: {
        query: "inbox",
      },
    });
    expect(remoteClient.callTool).toHaveBeenCalledWith({
      name: "gmail_search",
      arguments: {
        query: "inbox",
      },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "gmail-ok" }],
    });
    expect(release).not.toHaveBeenCalled();
    expect(inventoryListeners.size).toBe(1);
  });

  it("refreshes the tool surface after inventory updates without restarting the bridge", async () => {
    const release = vi.fn(async () => undefined);
    const inventoryListeners = new Set<(snapshot: { apps: AppInfo[] }) => void>();
    let inventory = [
      createApp({
        id: "gmail",
        name: "Gmail",
        isAccessible: true,
        isEnabled: true,
      }),
      createApp({
        id: "google_drive",
        name: "Google Drive",
        isAccessible: false,
        isEnabled: true,
      }),
    ];
    const remoteClient = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: undefined })),
      listAllTools: vi.fn(async () => [
        {
          name: "gmail_search",
          description: "Search Gmail",
          inputSchema: { type: "object" as const },
        },
        {
          name: "drive_search",
          description: "Search Drive",
          inputSchema: { type: "object" as const },
        },
      ]),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      })),
      close: vi.fn(async () => undefined),
    };
    const bridge = new ChatgptAppsMcpBridge({
      stateDir: "/tmp/openclaw-chatgpt-apps-test",
      workspaceDir: "/tmp/openclaw-chatgpt-apps-test/workspace",
      config: {} as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
        },
      },
      acquireLease: (async () => ({
        session: {
          refreshInventory: async () => inventory,
          listMcpServerStatus: async () => [
            {
              name: "gmail",
              tools: {
                gmail_search: {
                  name: "gmail_search",
                  description: "Search Gmail",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "oAuth",
            },
            {
              name: "google_drive",
              tools: {
                drive_search: {
                  name: "drive_search",
                  description: "Search Drive",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "oAuth",
            },
          ],
          onInventoryUpdate: (listener: (snapshot: { apps: AppInfo[] }) => void) => {
            inventoryListeners.add(listener);
            return () => {
              inventoryListeners.delete(listener);
            };
          },
          snapshot: () => ({
            auth: {
              status: "ok" as const,
              accessToken: "token-1",
              accountId: "acct-1",
              planType: "plus" as const,
              identity: {
                chatgptUserId: "user-1",
                accountId: "acct-1",
                isWorkspaceAccount: false,
              },
            },
          }),
        },
        release,
      })) as never,
      remoteClientFactory: vi.fn(async () => remoteClient),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "1.0.0" });

    disposers.push(async () => {
      await client.close();
    });
    disposers.push(async () => {
      await bridge.close();
    });

    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const firstTools = await client.listTools();
    expect(firstTools.tools.map((tool) => tool.name)).toEqual(["chatgpt_app__gmail__gmail_search"]);

    inventory = [
      createApp({
        id: "gmail",
        name: "Gmail",
        isAccessible: true,
        isEnabled: true,
      }),
      createApp({
        id: "google_drive",
        name: "Google Drive",
        isAccessible: true,
        isEnabled: true,
      }),
    ];
    for (const listener of inventoryListeners) {
      listener({ apps: inventory });
    }

    const secondTools = await client.listTools();
    expect(secondTools.tools.map((tool) => tool.name)).toEqual([
      "chatgpt_app__gmail__gmail_search",
      "chatgpt_app__google_drive__drive_search",
    ]);
  });

  it("maps configured stable connector ids onto aggregated codex_apps tool status", async () => {
    const release = vi.fn(async () => undefined);
    const remoteClient = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: undefined })),
      listAllTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "gmail-live-shape-ok" }],
        structuredContent: {
          result: {
            next_page_token: "cursor-1",
          },
        },
      })),
      close: vi.fn(async () => undefined),
    };
    const bridge = new ChatgptAppsMcpBridge({
      stateDir: "/tmp/openclaw-chatgpt-apps-test",
      workspaceDir: "/tmp/openclaw-chatgpt-apps-test/workspace",
      config: {} as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
          connectors: {
            gmail: { enabled: true },
          },
        },
      },
      acquireLease: (async () => ({
        session: {
          refreshInventory: async () => [
            createApp({
              id: "connector_2128aebfecb84f64a069897515042a44",
              name: "Gmail",
              isAccessible: true,
              isEnabled: false,
            }),
          ],
          listMcpServerStatus: async () => [
            {
              name: "codex_apps",
              tools: {
                gmail_search_emails: {
                  name: "gmail_search_emails",
                  description: "Search Gmail",
                  inputSchema: {
                    type: "object" as const,
                    properties: {
                      query: {
                        type: "string" as const,
                      },
                      tags: {
                        anyOf: [
                          {
                            type: "array" as const,
                            items: {
                              type: "string" as const,
                            },
                          },
                          {
                            type: "null" as const,
                          },
                        ],
                        default: null,
                      },
                    },
                  },
                  outputSchema: {
                    type: "object" as const,
                    properties: {
                      result: {
                        type: "object" as const,
                        properties: {
                          next_page_token: {
                            type: "anyOf",
                            anyOf: [
                              {
                                type: "string" as const,
                              },
                              {
                                type: "null" as const,
                              },
                            ],
                            default: null,
                          },
                        },
                      },
                    },
                  },
                },
                google_drive_search: {
                  name: "google_drive_search",
                  description: "Search Drive",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "bearerToken",
            },
          ],
          onInventoryUpdate: () => () => {},
          snapshot: () => ({
            auth: {
              status: "ok" as const,
              accessToken: "token-1",
              accountId: "acct-1",
              planType: "business" as const,
              identity: {
                chatgptUserId: "user-1",
                accountId: "acct-1",
                isWorkspaceAccount: false,
              },
            },
          }),
        },
        release,
      })) as never,
      remoteClientFactory: vi.fn(async () => remoteClient),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "1.0.0" });

    disposers.push(async () => {
      await client.close();
    });
    disposers.push(async () => {
      await bridge.close();
    });

    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name)).toEqual([
      "chatgpt_app__gmail__gmail_search_emails",
    ]);
    expect(listedTools.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        query: {
          type: "string",
        },
        tags: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    });
    expect(listedTools.tools[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            next_page_token: {
              type: "string",
            },
          },
        },
      },
    });

    const result = await client.callTool({
      name: "chatgpt_app__gmail__gmail_search_emails",
      arguments: {
        query: "label:inbox newer_than:7d",
      },
    });
    expect(remoteClient.callTool).toHaveBeenCalledWith({
      name: "gmail_search_emails",
      arguments: {
        query: "label:inbox newer_than:7d",
      },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "gmail-live-shape-ok" }],
    });
  });

  it("maps aggregated codex_apps tool names for multiple configured connectors", async () => {
    const release = vi.fn(async () => undefined);
    const remoteClient = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: undefined })),
      listAllTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "connector-routing-ok" }],
      })),
      close: vi.fn(async () => undefined),
    };
    const bridge = new ChatgptAppsMcpBridge({
      stateDir: "/tmp/openclaw-chatgpt-apps-test",
      workspaceDir: "/tmp/openclaw-chatgpt-apps-test/workspace",
      config: {} as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
          connectors: {
            google_calendar: { enabled: true },
            google_drive: { enabled: true },
          },
        },
      },
      acquireLease: (async () => ({
        session: {
          refreshInventory: async () => [
            createApp({
              id: "connector_5f3c8c41a1e54ad7a76272c89e2554fa",
              name: "Google Drive",
              isAccessible: true,
              isEnabled: false,
            }),
            createApp({
              id: "connector_947e0d954944416db111db556030eea6",
              name: "Google Calendar",
              isAccessible: true,
              isEnabled: false,
            }),
          ],
          listMcpServerStatus: async () => [
            {
              name: "codex_apps",
              tools: {
                google_drive_search: {
                  name: "google_drive_search",
                  description: "Search Drive",
                  inputSchema: { type: "object" as const },
                },
                google_calendar_search: {
                  name: "google_calendar_search",
                  description: "Search Calendar",
                  inputSchema: { type: "object" as const },
                },
                gmail_search_emails: {
                  name: "gmail_search_emails",
                  description: "Search Gmail",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "bearerToken",
            },
          ],
          onInventoryUpdate: () => () => {},
          snapshot: () => ({
            auth: {
              status: "ok" as const,
              accessToken: "token-1",
              accountId: "acct-1",
              planType: "business" as const,
              identity: {
                chatgptUserId: "user-1",
                accountId: "acct-1",
                isWorkspaceAccount: false,
              },
            },
          }),
        },
        release,
      })) as never,
      remoteClientFactory: vi.fn(async () => remoteClient),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "1.0.0" });

    disposers.push(async () => {
      await client.close();
    });
    disposers.push(async () => {
      await bridge.close();
    });

    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name).sort()).toEqual([
      "chatgpt_app__google_calendar__google_calendar_search",
      "chatgpt_app__google_drive__google_drive_search",
    ]);

    await client.callTool({
      name: "chatgpt_app__google_calendar__google_calendar_search",
      arguments: {
        query: "after:2026-03-01",
      },
    });
    await client.callTool({
      name: "chatgpt_app__google_drive__google_drive_search",
      arguments: {
        query: "roadmap",
      },
    });

    expect(remoteClient.callTool).toHaveBeenNthCalledWith(1, {
      name: "google_calendar_search",
      arguments: {
        query: "after:2026-03-01",
      },
    });
    expect(remoteClient.callTool).toHaveBeenNthCalledWith(2, {
      name: "google_drive_search",
      arguments: {
        query: "roadmap",
      },
    });
  });

  it("supports wildcard connector enablement with explicit per-connector disables", async () => {
    const release = vi.fn(async () => undefined);
    const remoteClient = {
      listTools: vi.fn(async () => ({ tools: [], nextCursor: undefined })),
      listAllTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "wildcard-routing-ok" }],
      })),
      close: vi.fn(async () => undefined),
    };
    const bridge = new ChatgptAppsMcpBridge({
      stateDir: "/tmp/openclaw-chatgpt-apps-test",
      workspaceDir: "/tmp/openclaw-chatgpt-apps-test/workspace",
      config: {} as never,
      pluginConfig: {
        chatgptApps: {
          enabled: true,
          chatgptBaseUrl: "https://chatgpt.com",
          connectors: {
            "*": { enabled: true },
            gmail: { enabled: false },
          },
        },
      },
      acquireLease: (async () => ({
        session: {
          refreshInventory: async () => [
            createApp({
              id: "connector_2128aebfecb84f64a069897515042a44",
              name: "Gmail",
              isAccessible: true,
              isEnabled: false,
            }),
            createApp({
              id: "connector_5f3c8c41a1e54ad7a76272c89e2554fa",
              name: "Google Drive",
              isAccessible: true,
              isEnabled: false,
            }),
            createApp({
              id: "connector_947e0d954944416db111db556030eea6",
              name: "Google Calendar",
              isAccessible: true,
              isEnabled: false,
            }),
          ],
          listMcpServerStatus: async () => [
            {
              name: "codex_apps",
              tools: {
                gmail_search_emails: {
                  name: "gmail_search_emails",
                  description: "Search Gmail",
                  inputSchema: { type: "object" as const },
                },
                google_drive_search: {
                  name: "google_drive_search",
                  description: "Search Drive",
                  inputSchema: { type: "object" as const },
                },
                google_calendar_search: {
                  name: "google_calendar_search",
                  description: "Search Calendar",
                  inputSchema: { type: "object" as const },
                },
              },
              resources: [],
              resourceTemplates: [],
              authStatus: "bearerToken",
            },
          ],
          onInventoryUpdate: () => () => {},
          snapshot: () => ({
            auth: {
              status: "ok" as const,
              accessToken: "token-1",
              accountId: "acct-1",
              planType: "business" as const,
              identity: {
                chatgptUserId: "user-1",
                accountId: "acct-1",
                isWorkspaceAccount: false,
              },
            },
          }),
        },
        release,
      })) as never,
      remoteClientFactory: vi.fn(async () => remoteClient),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-test-client", version: "1.0.0" });

    disposers.push(async () => {
      await client.close();
    });
    disposers.push(async () => {
      await bridge.close();
    });

    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name).sort()).toEqual([
      "chatgpt_app__google_calendar__google_calendar_search",
      "chatgpt_app__google_drive__google_drive_search",
    ]);
  });
});
