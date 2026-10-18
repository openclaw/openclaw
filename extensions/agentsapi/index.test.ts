import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("Agents API environment metadata", () => {
  it.each([undefined, "openai_hosted", "self_hosted"] as const)(
    "projects only the configured hosted workspace: %s",
    (environment) => {
      const registerAgentHarness = vi.fn<(harness: AgentHarness) => void>();
      plugin.register(
        createTestPluginApi({
          id: "agentsapi",
          pluginConfig: environment ? { environment } : {},
          registerAgentHarness,
        }),
      );
      const harness = registerAgentHarness.mock.calls[0]![0];
      expect(harness.workspaceEnvironment).toEqual(
        environment === "self_hosted"
          ? undefined
          : { kind: "provider-hosted", label: "OpenAI (Agents API)" },
      );
      expect(harness.cloudPlacement).toBeUndefined();
      expect(
        harness.supports({
          provider: "openai",
          requestedRuntime: "agentsapi",
          modelProvider: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            preparedAuth: { source: "profile", requirement: "subscription" },
          },
        }).supported,
      ).toBe(false);
      expect(
        harness.supports({
          provider: "openai",
          requestedRuntime: "agentsapi",
          modelProvider: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            preparedAuth: { source: "profile", mode: "api-key" },
          },
        }).supported,
      ).toBe(true);
    },
  );
});
