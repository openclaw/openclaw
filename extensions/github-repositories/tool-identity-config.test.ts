import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { readGitHubConfig } from "./config-api.js";

const mocks = vi.hoisted(() => ({
  mutateAgentScopedPluginConfig:
    vi.fn<typeof import("openclaw/plugin-sdk/config-mutation").mutateAgentScopedPluginConfig>(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/config-mutation")>()),
  mutateAgentScopedPluginConfig: mocks.mutateAgentScopedPluginConfig,
}));

import { updateGitHubToolIdentityConfig } from "./tool-identity-config-api.js";

describe("GitHub identity config mutation", () => {
  it.each([undefined, false, true])(
    "preserves sandbox opt-in %s across replacement and removes it on inherit",
    async (allowInSandbox) => {
      const sandboxPolicy = allowInSandbox === undefined ? {} : { allowInSandbox };
      const previousIdentity = { profileId: `ghp_${"1".repeat(32)}`, ...sandboxPolicy };
      const nextIdentity = { profileId: `ghp_${"2".repeat(32)}`, kind: "oauth" as const };
      const draft: OpenClawConfig = {
        agents: {
          entries: {
            main: {
              tools: {},
            },
          },
        },
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                agents: {
                  main: previousIdentity,
                },
              },
            },
          },
        },
      };
      mocks.mutateAgentScopedPluginConfig.mockImplementation(async (selection, mutate) => {
        expect(selection).toEqual({
          pluginId: "github-repositories",
          agent: { id: "main", createIfMissing: expect.any(Boolean) },
        });
        const plugin = draft.plugins!.entries![selection.pluginId]!;
        plugin.config = await mutate(plugin.config);
        return draft;
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        identity: nextIdentity,
        expectedIdentity: previousIdentity,
      });
      expect(readGitHubConfig(draft).agents?.["main"]).toStrictEqual({
        ...nextIdentity,
        ...sandboxPolicy,
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        expectedIdentity: { ...nextIdentity, ...sandboxPolicy },
      });
      expect(readGitHubConfig(draft).agents?.["main"]).toBeUndefined();
    },
  );
});
