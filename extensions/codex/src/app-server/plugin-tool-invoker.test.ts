import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { buildConfiguredCodexPluginRecords } from "./plugin-inventory.js";
import { invokeCodexPluginTool } from "./plugin-tool-invoker.js";
import type { CodexServerNotification, JsonValue } from "./protocol.js";

type RequestHandler = (request: {
  id: number | string;
  method: string;
  params?: JsonValue;
}) => JsonValue | undefined | Promise<JsonValue | undefined>;

class FakeCodexClient {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly prompts: string[] = [];
  readonly elicitationResponses: JsonValue[] = [];
  private readonly notificationHandlers = new Set<
    (notification: CodexServerNotification) => void
  >();
  private readonly requestHandlers = new Set<RequestHandler>();

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "openai-curated",
            path: "/market/openai-curated",
            plugins: [
              {
                id: "google-calendar",
                name: "google-calendar",
                installed: false,
                enabled: false,
                interface: { displayName: "Google Calendar" },
              },
            ],
          },
        ],
      } as T;
    }
    if (method === "plugin/install") {
      return { authPolicy: null, appsNeedingAuth: [] } as T;
    }
    if (method === "app/list") {
      const cursor = (params as { cursor?: unknown } | undefined)?.cursor;
      if (!cursor) {
        return { data: [], nextCursor: "page-2" } as T;
      }
      return {
        data: [
          {
            id: "calendar",
            isAccessible: true,
            isEnabled: false,
            pluginDisplayNames: ["Google Calendar"],
          },
        ],
        nextCursor: null,
      } as T;
    }
    if (
      method === "skills/list" ||
      method === "hooks/list" ||
      method === "mcpServerStatus/list" ||
      method === "config/mcpServer/reload" ||
      method === "config/batchWrite"
    ) {
      return undefined as T;
    }
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } } as T;
    }
    if (method === "turn/start") {
      const prompt = (params as { input: Array<{ text: string }> }).input[0]?.text ?? "";
      this.prompts.push(prompt);
      setTimeout(() => {
        void this.dispatchRequest({
          id: "elicitation-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: null,
            requestedSchema: {
              properties: {
                approve: { type: "boolean", title: "Approve action" },
              },
            },
          },
        });
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "item-1", text: "Calendar says 10 AM is open." },
            completedAtMs: Date.now(),
          },
        });
        this.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        });
      }, 0);
      return { turn: { id: "turn-1", status: "inProgress", error: null } } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  addNotificationHandler(handler: (notification: CodexServerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  addRequestHandler(handler: RequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  private emit(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }

  private async dispatchRequest(request: Parameters<RequestHandler>[0]): Promise<void> {
    for (const handler of this.requestHandlers) {
      const response = await handler(request);
      if (response !== undefined) {
        this.elicitationResponses.push(response);
        return;
      }
    }
  }
}

describe("Codex plugin tool invoker", () => {
  it("installs the selected source plugin, enables related apps, and runs a mentioned Codex turn", async () => {
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          "google-calendar": {
            enabled: true,
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
      },
    };
    const record = buildConfiguredCodexPluginRecords(pluginConfig)[0];
    const fake = new FakeCodexClient();

    const result = await invokeCodexPluginTool({
      pluginConfig,
      record,
      request: "Find a free slot tomorrow.",
      context: {
        workspaceDir: "/tmp/openclaw-codex-plugin-test",
        config: { agents: { defaults: { model: "anthropic/claude-sonnet-4.6" } } },
      },
      clientFactory: async () => fake as unknown as CodexAppServerClient,
    });

    expect(result.text).toBe("Calendar says 10 AM is open.");
    expect(fake.calls.map((call) => call.method)).toContain("plugin/install");
    expect(fake.calls.find((call) => call.method === "config/batchWrite")?.params).toMatchObject({
      edits: [{ keyPath: "apps.calendar.enabled", value: true, mergeStrategy: "upsert" }],
      reloadUserConfig: true,
    });
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "app/list",
          params: expect.objectContaining({ forceRefetch: true }),
        }),
        expect.objectContaining({
          method: "app/list",
          params: expect.objectContaining({ forceRefetch: true, cursor: "page-2" }),
        }),
        expect.objectContaining({
          method: "thread/start",
          params: expect.objectContaining({
            model: "claude-sonnet-4.6",
            modelProvider: "anthropic",
          }),
        }),
      ]),
    );
    expect(fake.elicitationResponses).toEqual([{ action: "decline", content: null, _meta: null }]);
    expect(fake.prompts[0]).toContain("[@Google Calendar](plugin://google-calendar)");
    expect(fake.prompts[0]).toContain("Find a free slot tomorrow.");
  });
});
