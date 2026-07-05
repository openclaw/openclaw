// Memory Core tests cover dreaming command plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
<<<<<<< HEAD
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { handleDreamingCommand } from "./dreaming-command.js";
=======
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerDreamingCommand } from "./dreaming-command.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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
<<<<<<< HEAD
=======
  const registered: { command?: OpenClawPluginCommandDefinition } = {};
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  let runtimeConfig: OpenClawConfig = initialConfig;

  const runtime = {
    config: {
      current: vi.fn(() => runtimeConfig),
      loadConfig: vi.fn(() => runtimeConfig),
      mutateConfigFile: vi.fn(async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
        const draft = structuredClone(runtimeConfig);
        mutate(draft);
        runtimeConfig = draft;
        return {
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: null,
          snapshot: {},
          nextConfig: runtimeConfig,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result: undefined,
        };
      }),
      replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
        runtimeConfig = nextConfig;
      }),
      writeConfigFile: vi.fn(async (nextConfig: OpenClawConfig) => {
        runtimeConfig = nextConfig;
      }),
    },
  } as unknown as OpenClawPluginApi["runtime"];

  const api = {
    runtime,
<<<<<<< HEAD
  } as unknown as OpenClawPluginApi;

  return {
    api,
=======
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      registered.command = definition;
    }),
  } as unknown as OpenClawPluginApi;

  registerDreamingCommand(api);

  if (!registered.command) {
    throw new Error("memory-core did not register /dreaming");
  }

  return {
    command: registered.command,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    runtime,
    getRuntimeConfig: () => runtimeConfig,
  };
}

function createCommandContext(
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes">>,
): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config: {},
    gatewayClientScopes: overrides?.gatewayClientScopes,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

<<<<<<< HEAD
async function runDreamingCommand(
  harness: ReturnType<typeof createHarness>,
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes">>,
) {
  return await handleDreamingCommand(harness.api, createCommandContext(args, overrides));
}

describe("memory-core /dreaming command", () => {
  it("shows phase explanations when invoked without args", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness);
=======
describe("memory-core /dreaming command", () => {
  it("registers with an enable/disable description", () => {
    const { command } = createHarness();
    expect(command.name).toBe("dreaming");
    expect(command.acceptsArgs).toBe(true);
    expect(command.description).toContain("Enable or disable");
  });

  it("shows phase explanations when invoked without args", async () => {
    const { command } = createHarness();
    const result = await command.handler(createCommandContext());
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- implementation detail: each sweep runs light -> REM -> deep.");
    expect(result.text).toContain(
      "- deep is the only stage that writes durable entries to MEMORY.md.",
    );
  });

  it("persists global enablement under plugins.entries.memory-core.config.dreaming.enabled", async () => {
<<<<<<< HEAD
    const harness = createHarness({
=======
    const { command, runtime, getRuntimeConfig } = createHarness({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
                frequency: "0 */6 * * *",
              },
            },
          },
        },
      },
    });

<<<<<<< HEAD
    const result = await runDreamingCommand(harness, "off");

    expect(harness.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    const storedDreaming = resolveStoredDreaming(harness.getRuntimeConfig());
=======
    const result = await command.handler(createCommandContext("off"));

    expect(runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    const storedDreaming = resolveStoredDreaming(getRuntimeConfig());
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(storedDreaming.enabled).toBe(false);
    expect(storedDreaming.frequency).toBe("0 */6 * * *");
    expect(result.text).toContain("Dreaming disabled.");
  });

  it("blocks unscoped gateway callers from persisting dreaming config", async () => {
<<<<<<< HEAD
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "off", {
      gatewayClientScopes: [],
    });

    expect(result.text).toContain("requires operator.admin");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("blocks write-scoped gateway callers from persisting dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "off", {
      gatewayClientScopes: ["operator.write"],
    });

    expect(result.text).toContain("requires operator.admin");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("allows admin-scoped gateway callers to persist dreaming config", async () => {
    const harness = createHarness();

    const result = await runDreamingCommand(harness, "on", {
      gatewayClientScopes: ["operator.admin"],
    });

    expect(harness.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(harness.getRuntimeConfig()).enabled).toBe(true);
=======
    const { command, runtime } = createHarness();

    const result = await command.handler(
      createCommandContext("off", {
        gatewayClientScopes: [],
      }),
    );

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("blocks write-scoped gateway callers from persisting dreaming config", async () => {
    const { command, runtime } = createHarness();

    const result = await command.handler(
      createCommandContext("off", {
        gatewayClientScopes: ["operator.write"],
      }),
    );

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("allows admin-scoped gateway callers to persist dreaming config", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness();

    const result = await command.handler(
      createCommandContext("on", {
        gatewayClientScopes: ["operator.admin"],
      }),
    );

    expect(runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig()).enabled).toBe(true);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(result.text).toContain("Dreaming enabled.");
  });

  it("returns status without mutating config", async () => {
<<<<<<< HEAD
    const harness = createHarness({
=======
    const { command, runtime } = createHarness({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                frequency: "15 */8 * * *",
              },
            },
          },
        },
      },
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    });

<<<<<<< HEAD
    const result = await runDreamingCommand(harness, "status");
=======
    const result = await command.handler(createCommandContext("status"));
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- enabled: off (America/Los_Angeles)");
    expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
    expect(result.text).toContain("- promotion policy: score>=0.8, recalls>=3, uniqueQueries>=3");
<<<<<<< HEAD
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness, "unknown-mode");

    expect(result.text).toContain("Usage: /dreaming status");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
=======
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const { command, runtime } = createHarness();
    const result = await command.handler(createCommandContext("unknown-mode"));

    expect(result.text).toContain("Usage: /dreaming status");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
});
