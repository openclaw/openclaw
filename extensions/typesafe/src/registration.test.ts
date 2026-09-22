import assert from "node:assert/strict";
import fs from "node:fs";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { Check } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { evaluate } from "./client.js";
import { ConfigSchema, runtimeConfig } from "./config.js";

// Registration tests exercise host wiring without dispatching HTTP requests.
vi.mock("./client.js", () => ({ evaluate: vi.fn() }));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
beforeEach(() => vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1 }));

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

describe("plugin ownership and configuration", () => {
  it("accepts SecretRefs and rejects plaintext source configuration", () => {
    for (const source of ["store", "env", "file", "exec"]) {
      expect(
        Check(ConfigSchema, { apiKey: { source, provider: "default", id: "TYPESAFE_API_KEY" } }),
      ).toBe(true);
    }
    expect(Check(ConfigSchema, { apiKey: "synthetic-plaintext" })).toBe(false);
    expect(
      Check(ConfigSchema, { apiKey: { source: "other", provider: "default", id: "key" } }),
    ).toBe(false);
    expect(Check(ConfigSchema, { timeoutMs: 60001 })).toBe(false);
    expect(Check(ConfigSchema, {})).toBe(true);
    expect(manifest.configSchema).toEqual(structuredClone(ConfigSchema));
    expect(manifest.configContracts.secretInputs.paths).toEqual([
      { path: "apiKey", expected: "string", ownerKind: "capability" },
    ]);
    expect(manifest.uiHints.apiKey.sensitive).toBe(true);
  });
  it("registers the optional tool and separate typed provider without custom UI or sessions", async () => {
    const registerTool = vi.fn();
    // Only the supported registrations exist; any accidental registration fails this test.
    const api = {
      pluginConfig: { apiKey: "synthetic-runtime-secret" },
      runtime: {
        config: {
          current: () => ({
            plugins: { entries: { typesafe: { config: { apiKey: "synthetic-runtime-secret" } } } },
          }),
        },
      },
      registerTool,
      registerDecisionProvider: vi.fn(),
    } as unknown as OpenClawPluginApi;
    plugin.register(api);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const registration = registerTool.mock.calls[0];
    assert(registration);
    const tool: AnyAgentTool = registration[0];
    expect(tool.name).toBe("typesafe_evaluate");
    expect(registration[1]).toEqual({ optional: true });
    expect(manifest.contracts).toEqual({
      tools: ["typesafe_evaluate"],
      decisionProviders: ["typesafe"],
    });
    expect(manifest.decisionModels).toEqual([
      { provider: "typesafe", id: "jev-latest", name: "Jev" },
      { provider: "typesafe", id: "jev-1.13.0", name: "Jev 1.13.0" },
      { provider: "typesafe", id: "kev-latest", name: "Kev (local server)" },
    ]);
    expect(manifest.providers).toBeUndefined();
    expect(manifest.modelCatalog).toBeUndefined();
    expect(manifest.controlUi).toBeUndefined();
    const metadata = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(metadata.openclaw.controlUi).toBeUndefined();
    expect(metadata.openclaw.extensions).toEqual(["./index.ts"]);
    expect(manifest.enabledByDefault).toBe(false);
    expect(api.registerDecisionProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "typesafe", contractVersion: 1 }),
    );
  });
  it("reports missing credentials and fails before evaluation", async () => {
    const registerTool = vi.fn();
    plugin.register({
      pluginConfig: {},
      runtime: { config: { current: () => ({}) } },
      registerTool,
      registerDecisionProvider: vi.fn(),
    } as unknown as OpenClawPluginApi);
    const registration = registerTool.mock.calls[0];
    assert(registration);
    const tool: AnyAgentTool = registration[0];
    vi.mocked(evaluate).mockClear();
    await expect(
      tool.execute("test", {
        state: "test",
        questions: { relevant: { type: "noul", instructions: "Relevant?" } },
      }),
    ).rejects.toThrow("API key is missing");
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("keeps runtime configuration bounded", () => {
    expect(() => runtimeConfig({ model: "unsafe model" })).toThrow();
    expect(() => runtimeConfig({ timeoutMs: -1 })).toThrow();
  });
});

// Keep the same registered handlers through runtime-secret snapshot replacement.
it("uses current credentials through rotation, unavailability and recovery", async () => {
  let current: Record<string, unknown> = { apiKey: "synthetic-A" };
  const registerTool = vi.fn();

  plugin.register({
    pluginConfig: { apiKey: "stale-registration-key" },
    runtime: {
      config: { current: () => ({ plugins: { entries: { typesafe: { config: current } } } }) },
    },
    registerTool,
    registerDecisionProvider: vi.fn(),
  } as unknown as OpenClawPluginApi);
  const registration = registerTool.mock.calls[0];
  assert(registration);
  const tool: AnyAgentTool = registration[0];
  vi.mocked(evaluate).mockReset();
  vi.mocked(evaluate).mockResolvedValue({
    evaluation: {
      model: "jev-test",
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  for (const key of ["synthetic-A", "synthetic-B", undefined, "synthetic-C"]) {
    current = key
      ? { apiKey: key }
      : { apiKey: { source: "env", provider: "default", id: "SYNTHETIC_TYPESAFE_UNAVAILABLE" } };
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: key });
    const calls = vi.mocked(evaluate).mock.calls.length;
    const pending = tool.execute("test", {
      state: null,
      questions: { q: { type: "noul", instructions: "test" } },
    });
    if (key) {
      const result = await pending;
      expect(JSON.stringify(result)).not.toContain(key);
      expect(vi.mocked(evaluate).mock.lastCall?.[1].apiKey).toBe(key);
    } else {
      await expect(pending).rejects.toThrow("API key is missing");
      expect(evaluate).toHaveBeenCalledTimes(calls);
    }
  }
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2, value: "synthetic-C" });
  vi.mocked(evaluate).mockRejectedValueOnce(new Error("Synthetic evaluator failure"));
  await expect(
    tool.execute("test", { state: null, questions: { q: { type: "noul", instructions: "test" } } }),
  ).rejects.toThrow("Synthetic evaluator failure");
});

it("uses only prepared references for the registered tool without stale fallback", async () => {
  const registerTool = vi.fn();

  const ref = { source: "env", provider: "default", id: "TYPESAFE_REGISTRATION_FIXTURE" };
  plugin.register({
    pluginConfig: { apiKey: "stale-registration-key" },
    runtime: {
      config: {
        current: () => ({ plugins: { entries: { typesafe: { config: { apiKey: ref } } } } }),
      },
    },
    registerTool,
    registerDecisionProvider: vi.fn(),
  } as unknown as OpenClawPluginApi);
  const registration = registerTool.mock.calls[0];
  assert(registration);
  const tool: AnyAgentTool = registration[0];
  const request = { state: null, questions: { q: { type: "noul", instructions: "test" } } };
  vi.mocked(evaluate).mockReset();
  vi.mocked(evaluate).mockResolvedValue({
    evaluation: {
      model: "jev-test",
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  try {
    // The same registrations must observe both rotation and loss of the configured ref.
    for (const key of ["synthetic-ref-A", "synthetic-ref-B", undefined]) {
      vi.stubEnv(ref.id, key);
      vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: key });
      const calls = vi.mocked(evaluate).mock.calls.length;
      if (key) {
        const result = await tool.execute("test", request);
        expect(JSON.stringify(result)).not.toContain(key);
        expect(vi.mocked(evaluate).mock.lastCall?.[1].apiKey).toBe(key);
      } else {
        await expect(tool.execute("test", request)).rejects.toThrow("API key is missing");
        expect(evaluate).toHaveBeenCalledTimes(calls);
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("executes the registered provider with prepared credentials and preserves cancellation", async () => {
  const registerDecisionProvider = vi.fn();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerTool: vi.fn(),
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const registration = registerDecisionProvider.mock.calls[0];
  assert(registration);
  const provider = registration[0];
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
  vi.mocked(evaluate).mockReset();
  vi.mocked(evaluate).mockResolvedValue({
    evaluation: {
      model: "jev-test",
      answers: { q: { type: "noul", noul: 0.37 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
  const batch = { state: "synthetic evidence", questions: { q: { type: "boolean" } } };
  const controller = new AbortController();
  const context = {
    model: "jev-agent-selected",
    agentId: "research",
    signal: controller.signal,
    deadlineMonotonicMs: performance.now() + 1000,
  };
  expect(provider.isReady()).toBe(true);
  await expect(provider.evaluate(batch, context)).resolves.toMatchObject({
    status: "ok",
    result: { answers: { q: { type: "boolean", probabilityTrue: 0.37 } } },
  });
  expect(vi.mocked(evaluate).mock.lastCall?.[0]).toMatchObject({
    questions: { q: { type: "noul" } },
  });
  expect(vi.mocked(evaluate).mock.lastCall?.[1].apiKey).toBe("synthetic-key");
  expect(vi.mocked(evaluate).mock.lastCall?.[2]).toBe(controller.signal);
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context)).rejects.toThrow("caller closed");
  expect(evaluate).toHaveBeenCalledTimes(1);
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2 });
  expect(provider.isReady()).toBe(false);
});
