import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
  githubCopilotLoginCommand: vi.fn(),
  fetchCopilotUsage: vi.fn(),
}));

import plugin from "./index.js";

function registerProvider() {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      name: "GitHub Copilot",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: registerProviderMock,
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("github-copilot plugin", () => {
  it("skips catalog discovery when models.copilotDiscovery.enabled is false", async () => {
    const provider = registerProvider();

    const result = await provider.catalog.run({
      config: { models: { copilotDiscovery: { enabled: false } } },
      agentDir: "/tmp/agent",
      env: { GH_TOKEN: "gh_test_token" },
      resolveProviderApiKey: () => ({ apiKey: "gh_test_token" }),
    } as never);

    expect(result).toBeNull();
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
  });
});
