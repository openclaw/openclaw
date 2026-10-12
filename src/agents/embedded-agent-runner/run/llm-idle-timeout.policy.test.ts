import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

type TimeoutParams = NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>;
const local = { baseUrl: "http://127.0.0.1:11434" };
const cloud = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
const defaults = (timeoutSeconds: number): OpenClawConfig => ({
  agents: { defaults: { timeoutSeconds } },
});

describe("LLM watchdog policy", () => {
  it.each<[string, TimeoutParams | undefined, number, number]>([
    ["short agent budget", { cfg: defaults(30) }, 30_000, 30_000],
    [
      "explicit local provider budget",
      { model: local, modelRequestTimeoutMs: 600_000 },
      600_000,
      600_000,
    ],
  ])("resolves idle and first-event budgets: %s", (_name, params, idle, firstEvent) => {
    expect(resolveLlmIdleTimeoutMs(params)).toBe(idle);
    expect(resolveLlmFirstEventTimeoutMs(params)).toBe(firstEvent);
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

  it.each([
    ["gpu", "http://gpu-box:8000/v1", { apiKey: "custom-local" }, 300_000, 600_000],
    ["custom-proxy", "http://gateway:4000/v1", undefined, 120_000, 60_000],
  ] satisfies [
    string | undefined,
    string,
    Partial<NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]> | undefined,
    number,
    number,
  ][])(
    "uses provider locality evidence for %s at %s",
    (provider, baseUrl, providerConfig, idle, cron) => {
      const cfg: OpenClawConfig | undefined =
        providerConfig && provider
          ? {
              models: {
                providers: {
                  [provider]: { baseUrl, api: "openai-completions", models: [], ...providerConfig },
                },
              },
            }
          : undefined;
      const model = { provider, baseUrl };
      expect(resolveLlmIdleTimeoutMs({ cfg, model })).toBe(idle);
      expect(resolveLlmFirstEventTimeoutMs({ cfg, model })).toBe(idle);
      expect(resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 })).toBe(
        cron,
      );
    },
  );

  it.each([
    ["kimi-k2.5:cloud", "http://127.0.0.1:11434", 0],
    ["gpt-oss:120b-cloud", "http://ollama-box:11434", 300_000],
  ])("keeps hosted watchdogs for custom Ollama model %s through %s", (id, baseUrl, localIdle) => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "local-ollama": { api: "ollama", apiKey: "ollama-local", baseUrl, models: [] },
        },
      },
    };
    const model = { provider: "local-ollama", id, baseUrl };
    expect({
      idle: resolveLlmIdleTimeoutMs({ cfg, model }),
      firstEvent: resolveLlmFirstEventTimeoutMs({ cfg, model }),
      cron: resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 }),
      local: resolveLlmIdleTimeoutMs({ cfg, model: { ...model, id: "gemma4:latest" } }),
    }).toEqual({ idle: 120_000, firstEvent: 120_000, cron: 60_000, local: localIdle });
  });
});
