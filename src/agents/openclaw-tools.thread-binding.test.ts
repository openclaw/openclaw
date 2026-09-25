import { afterEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("registered sessions_spawn binding discovery", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("never offers thread binding on a channel that supports it", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "binding-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "binding-chat", label: "Binding chat" }),
            conversationBindings: {
              defaultTopLevelPlacement: "child",
              supportsCurrentConversationBinding: true,
            },
          },
        },
      ]),
    );
    const config = { session: { threadBindings: { enabled: true, spawnSessions: true } } };
    const tool = createOpenClawTools({
      agentChannel: "binding-chat",
      config,
      disableMessageTool: true,
      disablePluginTools: true,
    }).find((candidate) => candidate.name === "sessions_spawn");
    expect(tool).toBeDefined();
    // Agent-started spawns never bind a conversation, whatever the channel offers.
    expect(tool?.parameters).toMatchObject({ properties: { mode: { enum: ["run", "session"] } } });
    expect(tool?.parameters).not.toHaveProperty("properties.thread");
    const capabilities = collectRuntimeChannelCapabilities({
      cfg: config,
      channel: "binding-chat",
    });
    expect(capabilities ?? []).not.toContain("threadbound-subagent-spawn");
    expect(capabilities ?? []).not.toContain("threadbound-acp-spawn");
  });
});
