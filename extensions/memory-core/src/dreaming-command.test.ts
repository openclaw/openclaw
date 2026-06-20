// Memory Core tests cover dreaming command plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerDreamingCommand } from "./dreaming-command.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveStoredDreaming(config: OpenClawConfig): Record<string, unknown> {
  const memory = asRecord(config.memory);
  const extensions = asRecord(memory?.extensions);
  const memoryCore = asRecord(extensions?.["memory-core"]);
  return asRecord(memoryCore?.dreaming) ?? {};
}

function resolveAgentStoredDreaming(
  config: OpenClawConfig,
  agentId: string,
): Record<string, unknown> {
  const agent = config.agents?.list?.find((entry) => entry.id === agentId);
  const memory = asRecord(agent?.memory);
  const extensions = asRecord(memory?.extensions);
  const memoryCore = asRecord(extensions?.["memory-core"]);
  return asRecord(memoryCore?.dreaming) ?? {};
}

function createHarness(initialConfig: OpenClawConfig = {}) {
  const registered: { command?: OpenClawPluginCommandDefinition } = {};
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
    runtime,
    getRuntimeConfig: () => runtimeConfig,
  };
}

function createCommandContext(
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "agentId" | "gatewayClientScopes" | "sessionKey">>,
): PluginCommandContext {
  return {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config: {},
    agentId: overrides?.agentId,
    gatewayClientScopes: overrides?.gatewayClientScopes,
    sessionKey: overrides?.sessionKey,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

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

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- implementation detail: each sweep runs light -> REM -> deep.");
    expect(result.text).toContain(
      "- deep is the only stage that writes durable entries to MEMORY.md.",
    );
  });

  it("persists default-agent enablement under memory.extensions.memory-core", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness({
      memory: {
        extensions: {
          "memory-core": {
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
    });

    const result = await command.handler(createCommandContext("off"));

    expect(runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
    const storedDreaming = resolveStoredDreaming(getRuntimeConfig());
    expect(storedDreaming.enabled).toBe(false);
    expect(storedDreaming.frequency).toBe("0 */6 * * *");
    expect(result.text).toContain("Dreaming disabled.");
  });

  it("uses the host-routed agent when the session key does not encode one", async () => {
    const { command, getRuntimeConfig } = createHarness({
      memory: {
        extensions: {
          "memory-core": {
            dreaming: { enabled: true },
          },
        },
      },
      agents: {
        list: [{ id: "research" }],
      },
    });

    await command.handler(
      createCommandContext("off", {
        agentId: "research",
        sessionKey: "plugin-owned:command-session",
      }),
    );

    expect(resolveStoredDreaming(getRuntimeConfig()).enabled).toBe(true);
    expect(resolveAgentStoredDreaming(getRuntimeConfig(), "research").enabled).toBe(false);
  });

  it("matches host-routed canonical agent ids to raw configured ids", async () => {
    const { command, getRuntimeConfig } = createHarness({
      memory: {
        extensions: {
          "memory-core": {
            dreaming: { enabled: true },
          },
        },
      },
      agents: {
        list: [{ id: "Team Ops" }],
      },
    });

    await command.handler(
      createCommandContext("off", {
        agentId: "team-ops",
        sessionKey: "plugin-owned:command-session",
      }),
    );

    expect(resolveStoredDreaming(getRuntimeConfig()).enabled).toBe(true);
    expect(resolveAgentStoredDreaming(getRuntimeConfig(), "Team Ops").enabled).toBe(false);
  });

  it("rejects unknown routed agents without changing inherited defaults", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness({
      memory: {
        extensions: {
          "memory-core": {
            dreaming: { enabled: true },
          },
        },
      },
      agents: {
        list: [{ id: "research" }],
      },
    });

    const result = await command.handler(
      createCommandContext("off", {
        agentId: "writer",
        sessionKey: "plugin-owned:command-session",
      }),
    );

    expect(result.text).toContain('cannot be changed for unknown agent "writer"');
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
    expect(resolveStoredDreaming(getRuntimeConfig()).enabled).toBe(true);
  });

  it("blocks unscoped gateway callers from persisting dreaming config", async () => {
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
    expect(result.text).toContain("Dreaming enabled.");
  });

  it("returns status without mutating config", async () => {
    const { command, runtime } = createHarness({
      memory: {
        extensions: {
          "memory-core": {
            dreaming: {
              frequency: "15 */8 * * *",
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

    const result = await command.handler(createCommandContext("status"));

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- enabled: off (America/Los_Angeles)");
    expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
    expect(result.text).toContain("- promotion policy: score>=0.8, recalls>=3, uniqueQueries>=3");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const { command, runtime } = createHarness();
    const result = await command.handler(createCommandContext("unknown-mode"));

    expect(result.text).toContain("Usage: /dreaming status");
    expect(runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });
});
