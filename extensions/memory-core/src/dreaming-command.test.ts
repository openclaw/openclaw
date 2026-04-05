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
  it("registers with a phase-oriented description", () => {
    const { command } = createHarness();
    expect(command.name).toBe("dreaming");
    expect(command.acceptsArgs).toBe(true);
    expect(command.description).toContain("dreaming phases");
  });

  it("shows phase explanations when invoked without args", async () => {
    const { command } = createHarness();
    const result = await command.handler(createCommandContext());

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- light: sorts recent memory traces into dreams.md.");
    expect(result.text).toContain(
      "- deep: promotes durable memories into MEMORY.md and handles recovery when memory is thin.",
    );
    expect(result.text).toContain("- rem: writes reflection and pattern notes into dreams.md.");
  });

  it("persists global enablement under plugins.entries.memory-core.config.dreaming.enabled", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                phases: {
                  deep: {
                    minScore: 0.9,
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("off"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig())).toMatchObject({
      enabled: false,
      phases: {
        deep: {
          minScore: 0.9,
        },
      },
    });
    expect(result.text).toContain("Dreaming disabled.");
  });

  it("persists phase changes under plugins.entries.memory-core.config.dreaming.phases", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness();

    const result = await command.handler(createCommandContext("disable rem"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig())).toMatchObject({
      phases: {
        rem: {
          enabled: false,
        },
      },
    });
    expect(result.text).toContain("REM phase disabled.");
  });

  it("returns status without mutating config", async () => {
    const { command, runtime } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                timezone: "America/Los_Angeles",
                storage: {
                  mode: "both",
                  separateReports: true,
                },
                phases: {
                  deep: {
                    recencyHalfLifeDays: 21,
                    maxAgeDays: 45,
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("status"));

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- enabled: on (America/Los_Angeles)");
    expect(result.text).toContain("- storage: both + reports");
    expect(result.text).toContain("recencyHalfLifeDays=21");
    expect(result.text).toContain("maxAgeDays=45");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const { command, runtime } = createHarness();
    const result = await command.handler(createCommandContext("unknown-mode"));

    expect(result.text).toContain("Usage: /dreaming status");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });
});
