import { describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
}));

vi.mock("../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

describe("provider auth aliases", () => {
  it("treats deprecated auth choice ids as provider auth aliases", () => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          providerAuthChoices: [
            {
              provider: "openai-codex",
              method: "oauth",
              choiceId: "openai-codex",
              deprecatedChoiceIds: ["codex-cli", "openai-codex-import"],
            },
          ],
        },
      ],
      diagnostics: [],
    });

    expect(resolveProviderIdForAuth("codex-cli")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex-import")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex")).toBe("openai-codex");
  });
});
