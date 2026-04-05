import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { describe, expect, it, vi } from "vitest";
import { registerDreamingCommand } from "./dreaming-command.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveStoredDreaming(config: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(config.plugins?.entries?.["memory-core"]);
  const pluginConfig = asRecord(entry?.config);
  return asRecord(pluginConfig?.dreaming) ?? {};
}

function createHarness(initialConfig: OpenClawConfig = {}) {
  let command: OpenClawPluginCommandDefinition | undefined;
  let runtimeConfig: OpenClawConfig = initialConfig;

  const runtime = {
    config: {
      loadConfig: vi.fn(() => runtimeConfig),
      writeConfigFile: vi.fn(async (nextConfig: OpenClawConfig) => {
        runtimeConfig = nextConfig;
      }),
    },
  } as unknown as OpenClawPluginApi["runtime"];

  const api = {
    runtime,
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      command = definition;
    }),
  } as unknown as OpenClawPluginApi;

  registerDreamingCommand(api);

  if (!command) {
    throw new Error("memory-core did not register /dreaming");
  }

  return {
    command,
    runtime,
    getRuntimeConfig: () => runtimeConfig,
  };
}

function createCommandContext(args?: string): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config: {},
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

describe("memory-core /dreaming command", () => {
  it("registers with an options-aware description", () => {
    const { command } = createHarness();
    expect(command.name).toBe("dreaming");
    expect(command.acceptsArgs).toBe(true);
    expect(command.description).toContain("off|core|rem|deep");
  });

  it("shows mode explanations when invoked without args", async () => {
    const { command } = createHarness();
    const result = await command.handler(createCommandContext());

    expect(result.text).toContain("Usage: /dreaming off|core|rem|deep");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- off: disable automatic short-term to long-term promotion.");
    expect(result.text).toContain("- core: cadence=0 3 * * *;");
    expect(result.text).toContain("- rem: cadence=0 */6 * * *;");
    expect(result.text).toContain("- deep: cadence=0 */12 * * *;");
  });

  it("persists mode changes under plugins.entries.memory-core.config.dreaming.mode", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                minScore: 0.9,
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("rem"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig())).toMatchObject({
      mode: "rem",
      minScore: 0.9,
    });
    expect(result.text).toContain("Dreaming mode set to rem.");
    expect(result.text).toContain("minScore=0.9");
  });

  it("returns status without mutating config", async () => {
    const { command, runtime } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                mode: "deep",
                timezone: "America/Los_Angeles",
                recencyHalfLifeDays: 21,
                maxAgeDays: 45,
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("status"));

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- mode: deep");
    expect(result.text).toContain("- cadence: 0 */12 * * * (America/Los_Angeles)");
    expect(result.text).toContain("- aging: recencyHalfLifeDays=21, maxAgeDays=45");
    expect(result.text).toContain("- verboseLogging: off");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const { command, runtime } = createHarness();
    const result = await command.handler(createCommandContext("unknown-mode"));

    expect(result.text).toContain("Usage: /dreaming off|core|rem|deep");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });
});
