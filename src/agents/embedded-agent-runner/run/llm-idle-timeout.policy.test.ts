import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

type TimeoutParams = NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>;
const cloud = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
const defaults = (timeoutSeconds: number): OpenClawConfig => ({
  agents: { defaults: { timeoutSeconds } },
});
type Provider = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];
const providerConfig = (baseUrl: string, apiKey: string): Provider => ({
  baseUrl,
  apiKey,
  api: "openai-completions",
  models: [],
});
const withProviders = (providers: Record<string, Provider>): OpenClawConfig => ({
  models: { providers },
});
function expectBudgets(params: TimeoutParams, idle: number, firstEvent = idle) {
  expect(resolveLlmIdleTimeoutMs(params)).toBe(idle);
  expect(resolveLlmFirstEventTimeoutMs(params)).toBe(firstEvent);
}
function configured(keys: Record<string, string>, provider = " GPU "): TimeoutParams {
  const baseUrl = "http://gpu-box:8000/v1";
  return {
    model: { provider, baseUrl },
    cfg: withProviders(
      Object.fromEntries(
        Object.entries(keys).map(([key, marker]) => [key, providerConfig(baseUrl, marker)]),
      ),
    ),
  };
}
type LocalityCase = { params: TimeoutParams; expected: number; cron?: number };

describe("LLM watchdog policy", () => {
  it("caps idle and first-event watchdogs at the agent budget", () => {
    expectBudgets({ cfg: defaults(30) }, 30_000);
  });

  it("keeps the cloud watchdog finite when the configured run timeout is unlimited", () => {
    const cfg = defaults(0);
    const runTimeoutMs = resolveAgentTimeoutMs({ cfg });
    expect(runTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveLlmIdleTimeoutMs({ cfg, runTimeoutMs, model: cloud })).toBe(120_000);
  });

  it.each([
    ["http://localhost:11434", 0],
    ["http://100.64.0.5:11434", 0],
    ["http://[fe80::1]:11434", 0],
    ["http://172.32.0.1:11434", 120_000],
    ["http://192.169.1.1:11434", 120_000],
  ])("classifies the endpoint without DNS: %s", (baseUrl, expected) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(expected);
  });

  it.each`
    name                        | params                                                                        | expected   | cron
    ${"local marker"}           | ${configured({ gpu: "custom-local" }, "gpu")}                                 | ${300_000} | ${600_000}
    ${"unconfigured proxy"}     | ${{ model: { provider: "custom-proxy", baseUrl: "http://gateway:4000/v1" } }} | ${120_000} | ${60_000}
    ${"normalized key"}         | ${configured({ " GPU ": "custom-local" })}                                    | ${300_000} | ${undefined}
    ${"canonical key priority"} | ${configured({ " GPU ": "custom-local", gpu: "synthetic-remote" })}           | ${120_000} | ${undefined}
    ${"first normalized key"}   | ${configured({ " GPU ": "synthetic-remote", GPU: "custom-local" })}           | ${120_000} | ${undefined}
  `("uses $name for configured provider locality", ({ params, expected, cron }: LocalityCase) => {
    expectBudgets(params, expected);
    if (cron !== undefined) {
      expect(resolveLlmIdleTimeoutMs({ ...params, trigger: "cron", runTimeoutMs: 600_000 })).toBe(
        cron,
      );
    }
  });

  it.each<[string, string, Partial<Provider>]>([
    ["loopback relay", "http://127.0.0.1:8787", {}],
    ["bare hostname with local auth", "http://gateway:8787", { apiKey: "custom-local" }],
    [
      "bare hostname with local service",
      "http://gateway:8787",
      { localService: { command: "/usr/bin/relay" } },
    ],
  ])("uses hosted watchdogs for remote %s", (_name, baseUrl, extra) => {
    const cfg = withProviders({
      relay: { ...providerConfig(baseUrl, "synthetic-remote"), ...extra, remote: true },
    });
    const model = { provider: "relay", id: "claude-sonnet-4-6", baseUrl };
    expectBudgets({ cfg, model }, 120_000);
    expect(resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 })).toBe(
      60_000,
    );
  });

  it("keeps self-hosted provider identity local unless remote is true", () => {
    const model = { provider: "ollama-relay", baseUrl: "http://gateway:8787" };
    for (const remote of [undefined, false, true]) {
      const cfg = withProviders({
        "ollama-relay": { ...providerConfig(model.baseUrl, "synthetic-remote"), remote },
      });
      expectBudgets({ cfg, model }, remote ? 120_000 : 300_000);
    }
  });

  it("keeps explicit provider timeoutSeconds ahead of the remote hint", () => {
    const model = { provider: "relay", baseUrl: "http://127.0.0.1:8787" };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          relay: { baseUrl: model.baseUrl, api: "anthropic-messages", models: [], remote: true },
        },
      },
    };
    const params = { cfg, model, modelRequestTimeoutMs: 900_000 };
    expectBudgets(params, 900_000);
    expectBudgets({ ...params, trigger: "cron", runTimeoutMs: 600_000 }, 600_000);
    expectBudgets({ ...params, runTimeoutMs: 20_000 }, 20_000);
  });

  it.each([
    ["kimi-k2.5:cloud", "http://127.0.0.1:11434", 0],
    ["gpt-oss:120b-cloud", "http://ollama-box:11434", 300_000],
  ])("keeps hosted watchdogs for custom Ollama model %s through %s", (id, baseUrl, localIdle) => {
    const cfg = withProviders({
      "local-ollama": { ...providerConfig(baseUrl, "ollama-local"), api: "ollama" },
    });
    const model = { provider: "local-ollama", id, baseUrl };
    expect({
      idle: resolveLlmIdleTimeoutMs({ cfg, model }),
      firstEvent: resolveLlmFirstEventTimeoutMs({ cfg, model }),
      cron: resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 }),
      local: resolveLlmIdleTimeoutMs({ cfg, model: { ...model, id: "gemma4:latest" } }),
    }).toEqual({ idle: 120_000, firstEvent: 120_000, cron: 60_000, local: localIdle });
  });
});
