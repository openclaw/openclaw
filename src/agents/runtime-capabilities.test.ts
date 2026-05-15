import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: true,
            },
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("keeps per-kind automatic spawn support separate", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            conversationBindings: {
              defaultTopLevelPlacement: "current",
              supportsAutomaticThreadBindingSpawn: { subagent: true, acp: false },
            },
          },
        },
      ]),
    );

    const capabilities = collectRuntimeChannelCapabilities({
      channel: "telegram",
      accountId: "default",
      cfg: {
        channels: {
          telegram: {
            threadBindings: {
              spawnSessions: true,
            },
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });
});
