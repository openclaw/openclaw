import assert from "node:assert/strict";
import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
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
  it("registers only the typed provider without custom UI or sessions", async () => {
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
    expect(registerTool).not.toHaveBeenCalled();
    expect(manifest.contracts).toEqual({ decisionProviders: ["typesafe"] });
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
  it("keeps runtime configuration bounded", () => {
    expect(Check(ConfigSchema, { model: "jev-latest" })).toBe(false);
    expect(() => runtimeConfig({ timeoutMs: -1 })).toThrow();
  });
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
  // Keep one registered provider across credential rotation, loss, and recovery.
  for (const key of ["synthetic-rotated", undefined, "synthetic-recovered"]) {
    vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2, value: key });
    const calls = vi.mocked(evaluate).mock.calls.length;
    const outcome = await provider.evaluate(batch, context);
    if (key) {
      expect(outcome.status).toBe("ok");
      expect(vi.mocked(evaluate).mock.lastCall?.[1].apiKey).toBe(key);
      expect(JSON.stringify(outcome)).not.toContain(key);
    } else {
      expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(evaluate).toHaveBeenCalledTimes(calls);
    }
  }
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context)).rejects.toThrow("caller closed");
  expect(evaluate).toHaveBeenCalledTimes(3);
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2 });
  expect(provider.isReady()).toBe(false);
});
