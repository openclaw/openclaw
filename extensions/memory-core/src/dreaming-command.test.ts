import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { handleDreamingCommand } from "./dreaming-command.js";

function resolveStoredDreaming(config: OpenClawConfig): Record<string, unknown> {
  const entry = asNullableRecord(config.plugins?.entries?.["memory-core"]);
  const pluginConfig = asNullableRecord(entry?.config);
  return asNullableRecord(pluginConfig?.dreaming) ?? {};
}

function dreamingConfig(
  dreaming: Record<string, unknown>,
  config: OpenClawConfig = {},
): OpenClawConfig {
  return { ...config, plugins: { entries: { "memory-core": { config: { dreaming } } } } };
}

function createHarness(initialConfig: OpenClawConfig = {}) {
  let runtimeConfig: OpenClawConfig = initialConfig;

  const runtime = {
    config: {
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
    },
  } as unknown as OpenClawPluginApi["runtime"];

  const api = {
    runtime,
  } as unknown as OpenClawPluginApi;

  return {
    api,
    runtime,
    getRuntimeConfig: () => runtimeConfig,
  };
}

async function runDreamingCommand(
  harness: ReturnType<typeof createHarness>,
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes" | "senderIsOwner">>,
) {
  return await handleDreamingCommand(harness.api, {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config: harness.getRuntimeConfig(),
    ...overrides,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  });
}

describe("memory-core /dreaming command", () => {
  it("shows phase explanations when invoked without args", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness);

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- implementation detail: each sweep runs light -> REM -> deep.");
    expect(result.text).toContain(
      "- deep is the only stage that writes durable entries to MEMORY.md.",
    );
  });

  it.each([
    { caller: "non-owner channel", authority: {} },
    { caller: "write-scoped gateway", authority: { gatewayClientScopes: ["operator.write"] } },
  ])("blocks $caller from persisting dreaming config", async ({ authority }) => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness, "off", authority);
    expect(result.text).toContain(
      "requires owner status for channel callers or operator.admin for gateway clients",
    );
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      caller: "owner channel",
      args: "off",
      authority: { senderIsOwner: true },
      config: dreamingConfig({ phases: { deep: { minScore: 0.9 } }, frequency: "0 */6 * * *" }),
      stored: { enabled: false, frequency: "0 */6 * * *" },
      message: "disabled",
    },
    {
      caller: "admin gateway",
      args: "on",
      authority: { gatewayClientScopes: ["operator.admin"] },
      config: {},
      stored: { enabled: true },
      message: "enabled",
    },
  ])(
    "allows $caller to persist enablement",
    async ({ args, authority, config, stored, message }) => {
      const harness = createHarness(config);
      const result = await runDreamingCommand(harness, args, authority);
      expect(harness.runtime.config.mutateConfigFile).toHaveBeenCalledTimes(1);
      expect(resolveStoredDreaming(harness.getRuntimeConfig())).toMatchObject(stored);
      expect(result.text).toContain(`Dreaming ${message}.`);
    },
  );

  it("returns status without mutating config", async () => {
    const harness = createHarness(
      dreamingConfig(
        { frequency: "15 */8 * * *" },
        { agents: { defaults: { userTimezone: "America/Los_Angeles" } } },
      ),
    );

    const result = await runDreamingCommand(harness, "status");

    expect(result.text).toContain("Dreaming status:");
    // Dreaming is enabled by default; the fixture sets no explicit enabled flag.
    expect(result.text).toContain("- enabled: on (America/Los_Angeles)");
    expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
    expect(result.text).toContain("- promotion policy: score>=0.75, recalls>=3, uniqueQueries>=3");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const harness = createHarness();
    const result = await runDreamingCommand(harness, "unknown-mode");

    expect(result.text).toContain("Usage: /dreaming status");
    expect(harness.runtime.config.mutateConfigFile).not.toHaveBeenCalled();
  });
});
