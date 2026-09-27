import { afterEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("registered sessions_spawn binding discovery", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each([
    { placement: "current", supportsCurrent: true, spawnSessions: true, available: true },
    { placement: "current", supportsCurrent: false, spawnSessions: true, available: false },
    { placement: "current", supportsCurrent: true, spawnSessions: false, available: false },
    { placement: "child", supportsCurrent: false, spawnSessions: true, available: true },
  ] as const)(
    "$placement, current support=$supportsCurrent, spawn policy=$spawnSessions",
    ({ placement, supportsCurrent, spawnSessions, available }) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "binding-chat",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "binding-chat", label: "Binding chat" }),
              conversationBindings: {
                defaultTopLevelPlacement: placement,
                supportsCurrentConversationBinding: supportsCurrent,
              },
            },
          },
        ]),
      );
      const config = { session: { threadBindings: { enabled: true, spawnSessions } } };
      const tool = createOpenClawTools({
        agentChannel: "binding-chat",
        config,
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "sessions_spawn");
      expect(tool).toBeDefined();
      expect(tool?.parameters).toMatchObject({
        properties: { mode: { enum: available ? ["run", "session"] : ["run"] } },
      });
      if (available) {
        expect(tool?.parameters).toHaveProperty("properties.thread.type", "boolean");
      } else {
        expect(tool?.parameters).not.toHaveProperty("properties.thread");
      }
      const capabilities = collectRuntimeChannelCapabilities({
        cfg: config,
        channel: "binding-chat",
      });
      if (available) {
        expect(capabilities).toEqual(
          expect.arrayContaining(["threadbound-subagent-spawn", "threadbound-acp-spawn"]),
        );
      } else {
        expect(capabilities ?? []).not.toContain("threadbound-subagent-spawn");
        expect(capabilities ?? []).not.toContain("threadbound-acp-spawn");
      }
    },
  );
});
