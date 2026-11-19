import fs from "node:fs";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
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

it("rejects retired controller configuration without rewriting its owner", () => {
  const config = { environment: "self_hosted", executorController: "original-controller" };
  const before = structuredClone(config);
  const registerAgentHarness = vi.fn();
  expect(() =>
    plugin.register(
      createTestPluginApi({ id: "agentsapi", pluginConfig: config, registerAgentHarness }),
    ),
  ).toThrow(
    "Retire controlled sessions with the previous OpenClaw version and original controller plugin",
  );
  expect(config).toEqual(before);
  expect(registerAgentHarness).not.toHaveBeenCalled();

  const manifest = JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  const validate = (value: unknown) =>
    validateJsonSchemaValue({
      cacheKey: "agentsapi.manifest.config.test",
      schema: manifest.configSchema,
      value,
    });
  expect(validate(config).ok).toBe(false);
  expect(config).toEqual(before);
  expect(validate({ environment: "self_hosted" }).ok).toBe(true);
});
