import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("tinyfish plugin registration", () => {
  it("registers only the tinyfish_automation tool", () => {
    const registerTool = vi.fn();

    const api = {
      id: "tinyfish",
      name: "TinyFish",
      description: "TinyFish",
      source: "test",
      registrationMode: "full",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      logger: { info() {}, warn() {}, error() {} },
      registerTool,
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerSpeechProvider() {},
      registerMediaUnderstandingProvider() {},
      registerImageGenerationProvider() {},
      registerWebSearchProvider() {},
      registerInteractiveHandler() {},
      registerCommand() {},
      registerContextEngine() {},
      registerMemoryPromptSection() {},
      resolvePath(input: string) {
        return input;
      },
      onConversationBindingResolved() {},
      on() {},
    } as unknown as OpenClawPluginApi;

    plugin.register?.(api);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({
      name: "tinyfish_automation",
    });
  });
});
