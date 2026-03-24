import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "./runtime-api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) {
  let command: OpenClawPluginCommandDefinition | undefined;
  let tool: Parameters<OpenClawPluginApi["registerTool"]>[0] | undefined;
  const on = vi.fn();
  const registerCli = vi.fn();

  const api = createTestPluginApi({
    id: "openstream",
    name: "OpenStream",
    description: "OpenStream",
    source: "test",
    config: params?.config ?? {},
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      config: {
        loadConfig: () => params?.config ?? {},
      },
    } as OpenClawPluginApi["runtime"],
    registerCommand(nextCommand) {
      command = nextCommand;
    },
    registerTool(nextTool) {
      tool = nextTool;
    },
    registerCli,
    on,
  }) as OpenClawPluginApi;

  plugin.register(api);
  return { command, tool, on, registerCli };
}

describe("openstream plugin", () => {
  it("registers command, tool, cli, and prompt guidance hook", async () => {
    const { command, tool, on, registerCli } = createApi();

    expect(command?.name).toBe("openstream");
    expect(tool).toBeDefined();
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");

    const result = await on.mock.calls[0]?.[1]?.({}, {});
    expect(result).toMatchObject({
      prependSystemContext: expect.stringContaining("Prefer native tool calls"),
    });
  });

  it("renders doctor output for configured ollama models", async () => {
    const { command } = createApi({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              models: ["qwen3:latest", "deepseek-v3:671b"],
            },
          },
        },
      },
    });

    if (!command) {
      throw new Error("openstream command was not registered");
    }

    const result = await command.handler({
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/openstream doctor",
      args: "doctor",
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              models: ["qwen3:latest", "deepseek-v3:671b"],
            },
          },
        },
      },
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    const text = String(result?.text ?? "");
    expect(text).toContain("OpenStream doctor");
    expect(text).toContain("qwen3:latest");
    expect(text).toContain("deepseek-v3:671b");
    expect(text).toContain("prompt guidance: enabled");
  });

  it("returns model hint usage guidance when no model id is provided", async () => {
    const { command } = createApi();

    if (!command) {
      throw new Error("openstream command was not registered");
    }

    const result = await command.handler({
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/openstream model",
      args: "model",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(String(result?.text ?? "")).toContain("Usage: /openstream model <modelId>");
  });
});
