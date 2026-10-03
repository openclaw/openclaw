import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

type TimeoutParams = NonNullable<Parameters<typeof resolveLlmIdleTimeoutMs>[0]>;
const local = { baseUrl: "http://127.0.0.1:11434" };
const selfHosted = { provider: "vllm", baseUrl: "https://gpu.example.com/v1" };
const cloud = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
const defaults = (timeoutSeconds: number): OpenClawConfig => ({
  agents: { defaults: { timeoutSeconds } },
});

describe("LLM watchdog policy", () => {
  it.each<[string, TimeoutParams | undefined, number, number]>([
    ["absent config", undefined, 120_000, 120_000],
    ["missing defaults", { cfg: { agents: {} } }, 120_000, 120_000],
    ["short agent budget", { cfg: defaults(30) }, 30_000, 30_000],
    ["short run budget", { runTimeoutMs: 30_000 }, 30_000, 30_000],
    ["provider opt-in", { modelRequestTimeoutMs: 300_000 }, 300_000, 300_000],
    [
      "timer ceiling",
      { trigger: "cron", modelRequestTimeoutMs: 10_000_000_000 },
      MAX_TIMER_TIMEOUT_MS,
      MAX_TIMER_TIMEOUT_MS,
    ],
    ["negative provider budget", { modelRequestTimeoutMs: -1 }, 120_000, 120_000],
    ["infinite provider budget", { modelRequestTimeoutMs: Infinity }, 120_000, 120_000],
    [
      "agent bounds provider",
      { cfg: defaults(45), modelRequestTimeoutMs: 300_000 },
      45_000,
      45_000,
    ],
    [
      "run overrides agent",
      { cfg: defaults(45), modelRequestTimeoutMs: 300_000, runTimeoutMs: 180_000 },
      180_000,
      180_000,
    ],
    [
      "unlimited run overrides agent",
      { cfg: defaults(45), modelRequestTimeoutMs: 180_000, runTimeoutMs: MAX_TIMER_TIMEOUT_MS },
      180_000,
      180_000,
    ],
    ["unlimited cloud run", { runTimeoutMs: MAX_TIMER_TIMEOUT_MS, model: cloud }, 120_000, 120_000],
    [
      "unlimited self-hosted run",
      { runTimeoutMs: MAX_TIMER_TIMEOUT_MS, model: selfHosted },
      300_000,
      300_000,
    ],
    ["unlimited local run", { runTimeoutMs: MAX_TIMER_TIMEOUT_MS, model: local }, 0, 300_000],
    [
      "explicit local provider budget",
      { model: local, modelRequestTimeoutMs: 600_000 },
      600_000,
      600_000,
    ],
    ["short local run", { model: local, runTimeoutMs: 45_000 }, 45_000, 45_000],
    ["short local agent budget", { model: local, cfg: defaults(30) }, 30_000, 30_000],
    ["short self-hosted run", { model: selfHosted, runTimeoutMs: 90_000 }, 90_000, 90_000],
    ["cron provider opt-in", { trigger: "cron", modelRequestTimeoutMs: 300_000 }, 300_000, 300_000],
    ["cron without budget", { trigger: "cron" }, 120_000, 120_000],
    ["cron agent budget", { trigger: "cron", cfg: defaults(300) }, 120_000, 120_000],
    ["cron stall ceiling", { trigger: "cron", runTimeoutMs: 600_000 }, 60_000, 120_000],
    ["short cron run", { trigger: "cron", runTimeoutMs: 30_000 }, 30_000, 30_000],
    [
      "cron local exemption",
      { trigger: "cron", runTimeoutMs: 600_000, model: local },
      600_000,
      300_000,
    ],
    [
      "cron self-hosted exemption",
      { trigger: "cron", runTimeoutMs: 600_000, model: selfHosted },
      600_000,
      300_000,
    ],
  ])("resolves idle and first-event budgets: %s", (_name, params, idle, firstEvent) => {
    expect(resolveLlmIdleTimeoutMs(params)).toBe(idle);
    expect(resolveLlmFirstEventTimeoutMs(params)).toBe(firstEvent);
  });

  it.each([
    ["local", local, 3_600_000, 900_000],
    ["self-hosted", selfHosted, 300_000, 300_000],
    ["cloud", cloud, 120_000, 120_000],
  ])("preserves the %s idle tier under explicit budgets", (_name, model, agentIdle, runIdle) => {
    expect(resolveLlmIdleTimeoutMs({ cfg: defaults(3_600), model })).toBe(agentIdle);
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 900_000, model })).toBe(runIdle);
  });

  it("keeps the cloud watchdog finite when the configured run timeout is unlimited", () => {
    const cfg = defaults(0);
    const runTimeoutMs = resolveAgentTimeoutMs({ cfg });
    expect(runTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveLlmIdleTimeoutMs({ cfg, runTimeoutMs, model: cloud })).toBe(120_000);
  });

  it.each([
    ["http://localhost:11434", 0],
    ["http://127.0.0.2:11434", 0],
    ["http://0.0.0.0:11434", 0],
    ["http://[::1]:11434", 0],
    ["http://my-rig.local:11434", 0],
    ["http://10.0.0.5:11434", 0],
    ["http://172.16.5.10:11434", 0],
    ["http://192.168.1.20:11434", 0],
    ["http://100.64.0.5:11434", 0],
    ["http://[fc00::1]:11434", 0],
    ["http://[fe80::1]:11434", 0],
    ["http://[::FFFF:127.0.0.1]:11434", 0],
    ["http://172.32.0.1:11434", 120_000],
    ["http://192.169.1.1:11434", 120_000],
    ["http://100.63.255.254:11434", 120_000],
    ["http://100.128.0.1:11434", 120_000],
    ["http://[fec0::1]:11434", 120_000],
    ["http://[fc::1]:11434", 120_000],
    ["http://[::ffff:10.0.0.5]:11434", 120_000],
    ["http://10.0.0.5evil:11434", 120_000],
    ["http://1.2.3.4.5:11434", 120_000],
    ["https://api.openai.com/v1", 120_000],
    ["not-a-url", 120_000],
    ["", 120_000],
  ])("classifies the endpoint without DNS: %s", (baseUrl, expected) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(expected);
  });

  it.each([
    ["ollama-beelink", "http://ollama-host:11434", undefined, 300_000, 600_000],
    [undefined, "http://host.docker.internal:11434", undefined, 300_000, 600_000],
    ["gpu", "http://gpu-box:8000/v1", { apiKey: "custom-local" }, 300_000, 600_000],
    [
      "ds4",
      "http://ds4-box:8000/v1",
      {
        localService: {
          command: "/opt/ds4/ds4-server",
          healthUrl: "http://ds4-box:8000/v1/models",
        },
      },
      300_000,
      600_000,
    ],
    ["custom-proxy", "http://gateway:4000/v1", undefined, 120_000, 60_000],
    ["ollama-cloud", "http://ollama-host:11434", undefined, 120_000, 60_000],
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
