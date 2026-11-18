import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it } from "vitest";
import { daybreakAliasHealthCheck } from "./doctor-health-api.js";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "daybreak-doctor-health" });
});
afterEach(async () => {
  await state.cleanup();
});

const runtime = {
  log() {},
  error() {},
  exit(): never {
    throw new Error("unexpected exit");
  },
};

it("warns about retiring references without rewriting models or account pins", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-daybreak-blue-latest@openai:work",
          fallbacks: ["openai/gpt-daybreak-red-latest"],
        },
        models: { "openai/gpt-daybreak-blue-latest": { alias: "defensive" } },
      },
    },
  };
  const original = structuredClone(cfg);
  const result = await daybreakAliasHealthCheck.detect({
    cfg,
    env: state.env,
    mode: "lint",
    runtime,
  });
  expect(cfg).toEqual(original);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ severity: "warning" });
  expect(daybreakAliasHealthCheck).not.toHaveProperty("repair");
  for (const path of [
    "agents.defaults.model.primary",
    "agents.defaults.model.fallbacks.0",
    "agents.defaults.models.openai/gpt-daybreak-blue-latest",
  ]) {
    expect(result[0]?.message).toContain(path);
  }
  expect(result[0]?.message).toContain("October 28, 2026");
  expect(result[0]?.message).toContain("No automatic replacement");
  expect(
    await daybreakAliasHealthCheck.detect({ cfg, env: state.env, mode: "fix", runtime }),
  ).toEqual(result);
});

it("leaves specific models and other providers alone", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-daybreak-fixture-2026-10-01",
          fallbacks: ["custom/gpt-daybreak-blue-latest"],
        },
      },
    },
  };
  expect(
    await daybreakAliasHealthCheck.detect({ cfg, env: state.env, mode: "lint", runtime }),
  ).toEqual([]);
});
