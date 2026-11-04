import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { expect, it } from "vitest";
import { registerKnowledgeDoctorChecks } from "./doctor-health-api.js";

const runtime = { log() {}, error() {}, exit() {} };
const agents = { entries: { main: {}, work: {}, big: {} } };

/** The check as core registers it, with per-agent output limits standing in for config. */
function detect(cfg: OpenClawConfig, limits: Record<string, number | undefined>) {
  const registered: HealthCheck[] = [];
  registerKnowledgeDoctorChecks({
    getHealthCheck: () => undefined,
    registerHealthCheck: (check) => registered.push(check),
    resolveAgentModelOutputLimit: async ({ agentId }) => {
      const maxTokens = limits[agentId];
      const model = agentId === "big" ? "large" : "small";
      const path = "models.providers.local.maxTokens";
      return maxTokens === undefined ? undefined : { providerKey: "local", model, maxTokens, path };
    },
  });
  return registered[0]!.detect({ mode: "doctor", runtime, cfg: { agents, ...cfg } });
}

it("warns once per saving model below 64K output tokens", async () => {
  expect(await detect({}, { main: 8192, work: 8192, big: 65_536 })).toEqual([
    expect.objectContaining({
      checkId: "knowledge/model-output-limit",
      severity: "warning",
      path: "models.providers.local.maxTokens",
      message: expect.stringContaining("local/small, which can write only 8192 tokens"),
    }),
  ]);
  expect(await detect({}, { main: undefined, work: 65_536 })).toEqual([]);
});

it("stays quiet while Knowledge writes are off", async () => {
  const cfg = { plugins: { entries: { knowledge: { config: { writesEnabled: false } } } } };
  expect(await detect(cfg, { main: 8192 })).toEqual([]);
});
