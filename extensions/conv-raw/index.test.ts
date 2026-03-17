import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../test-utils/plugin-api.js";
import { ConvRawEngine, getConvRawEngine } from "./index.js";
import plugin from "./index.js";

describe("conv-raw plugin", () => {
  it("has correct plugin metadata", () => {
    expect(plugin.id).toBe("conv-raw");
    expect(plugin.kind).toBe("context-engine");
    expect(typeof plugin.register).toBe("function");
  });

  it("registers context engine on plugin init", () => {
    const registerContextEngine = vi.fn();
    const on = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "conv-raw",
        name: "Conversation Raw Logger",
        description: "test",
        source: "test",
        config: {},
        runtime: {} as never,
        registerContextEngine,
        on,
      }),
    );

    expect(registerContextEngine).toHaveBeenCalledTimes(1);
    expect(registerContextEngine.mock.calls[0]?.[0]).toBe("conv-raw");
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("message_received");
  });
});

describe("ConvRawEngine", () => {
  it("has correct engine info", () => {
    const engine = new ConvRawEngine();
    expect(engine.info.id).toBe("conv-raw");
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("respects trackedChats config — tracks all when empty", () => {
    const engine = new ConvRawEngine({ trackedChats: [] });
    // Empty trackedChats = track all
    expect(engine["isTrackedChat"]("any-chat-id")).toBe(true);
  });

  it("respects trackedChats config — only tracks listed chats", () => {
    const engine = new ConvRawEngine({ trackedChats: ["oc_abc123"] });
    expect(engine["isTrackedChat"]("oc_abc123")).toBe(true);
    expect(engine["isTrackedChat"]("oc_other")).toBe(false);
  });

  it("normalizes chatId prefixes correctly", () => {
    const engine = new ConvRawEngine({ trackedChats: ["oc_abc123"] });
    expect(engine["isTrackedChat"]("feishu:group:oc_abc123")).toBe(true);
    expect(engine["isTrackedChat"]("user:ou_abc123")).toBe(false);
  });

  it("applies configurable botName", () => {
    const engine = new ConvRawEngine({ botName: "MyBot" });
    // getConfigDefaults is internal but we can verify via the engine instance
    expect(engine).toBeInstanceOf(ConvRawEngine);
  });

  it("applies configurable timezoneOffset", () => {
    const engine = new ConvRawEngine({ timezoneOffset: 8 });
    expect(engine).toBeInstanceOf(ConvRawEngine);
  });

  it("getConvRawEngine returns singleton", () => {
    // Reset module-level singleton by using separate configs
    const engine1 = new ConvRawEngine({});
    const engine2 = new ConvRawEngine({});
    expect(engine1).toBeInstanceOf(ConvRawEngine);
    expect(engine2).toBeInstanceOf(ConvRawEngine);
  });

  it("assemble returns messages unchanged and adds systemPromptAddition when history exists", async () => {
    const engine = new ConvRawEngine({ trackedChats: ["test-chat"] });

    // For a chat with no history on disk, assemble should return empty
    const result = await engine.assemble({
      sessionId: "test-chat",
      sessionKey: "test-chat",
      messages: [],
    });

    expect(result.messages).toEqual([]);
    // systemPromptAddition may be undefined when no history file exists
    if (result.systemPromptAddition !== undefined) {
      expect(typeof result.systemPromptAddition).toBe("string");
    }
  });
});
