import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginCommandContext } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { handleDreamingCommand } from "./dreaming-command.js";

function dreamingConfig(
  dreaming: Record<string, unknown>,
  config: OpenClawConfig = {},
): OpenClawConfig {
  return { ...config, plugins: { entries: { "memory-core": { config: { dreaming } } } } };
}

async function runDreamingCommand(
  args?: string,
  initialConfig: OpenClawConfig = {},
  authority: Partial<Pick<PluginCommandContext, "gatewayClientScopes" | "senderIsOwner">> = {},
) {
  let config = initialConfig;
  const mutateConfigFile = vi.fn(
    async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
      config = structuredClone(config);
      mutate(config);
      return { nextConfig: config };
    },
  );
  const api = { runtime: { config: { mutateConfigFile } } } as unknown as OpenClawPluginApi;
  const result = await handleDreamingCommand(api, {
    channel: "webchat",
    isAuthorizedSender: true,
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    args,
    config,
    ...authority,
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  });
  return { ...result, config, mutateConfigFile };
}

describe("memory-core /dreaming command", () => {
  it.each([
    { caller: "non-owner channel", authority: {} },
    { caller: "write-scoped gateway", authority: { gatewayClientScopes: ["operator.write"] } },
  ])("blocks $caller from persisting dreaming config", async ({ authority }) => {
    const result = await runDreamingCommand("off", {}, authority);
    expect(result.text).toContain(
      "requires owner status for channel callers or operator.admin for gateway clients",
    );
    expect(result.mutateConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      caller: "owner channel",
      args: "off",
      authority: { senderIsOwner: true },
      config: dreamingConfig({ frequency: "0 */6 * * *" }),
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
      const result = await runDreamingCommand(args, config, authority);
      const pluginConfig = asNullableRecord(
        result.config.plugins?.entries?.["memory-core"]?.config,
      );
      expect(pluginConfig?.dreaming).toMatchObject(stored);
      expect(result.text).toContain(`Dreaming ${message}.`);
    },
  );

  it.each([undefined, "status", "unknown-mode"])(
    "reports %s without mutating config",
    async (args) => {
      const result = await runDreamingCommand(
        args,
        dreamingConfig(
          { frequency: "15 */8 * * *" },
          { agents: { defaults: { userTimezone: "America/Los_Angeles" } } },
        ),
      );

      expect(result.text).toContain("Dreaming status:");
      expect(result.text).toContain("- enabled: on (America/Los_Angeles)");
      expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
      expect(result.text).toContain(
        "- promotion policy: score>=0.75, recalls>=3, uniqueQueries>=3",
      );
      if (args !== "status") {
        expect(result.text).toContain("Usage: /dreaming status");
        expect(result.text).toContain(
          "- implementation detail: each sweep runs light -> REM -> deep.",
        );
        expect(result.text).toContain(
          "- deep is the only stage that writes durable entries to MEMORY.md.",
        );
      }
      expect(result.mutateConfigFile).not.toHaveBeenCalled();
    },
  );
});
