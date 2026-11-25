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
function expectBudgets(params: TimeoutParams, idle: number, firstEvent = idle) {
  expect(resolveLlmIdleTimeoutMs(params)).toBe(idle);
  expect(resolveLlmFirstEventTimeoutMs(params)).toBe(firstEvent);
}
function configured(
  keys: Record<string, string>,
  provider = " GPU ",
  extra: Partial<Provider> = {},
): TimeoutParams {
  const baseUrl = extra.baseUrl ?? "http://gpu-box:8000/v1";
  const providers = Object.fromEntries(
    Object.entries(keys).map(([key, marker]) => [
      key,
      { ...providerConfig(baseUrl, marker), ...extra },
    ]),
  );
  return { model: { provider, baseUrl }, cfg: { models: { providers } } };
}
type LocalityCase = { params: TimeoutParams; expected: number; cron?: number };

describe("LLM watchdog policy", () => {
  it.each([30, 0])("keeps finite and unlimited budgets (%s)", (seconds) => {
    const cfg = defaults(seconds);
    const runTimeoutMs = resolveAgentTimeoutMs({ cfg });
    expect(runTimeoutMs).toBe(seconds ? 30_000 : MAX_TIMER_TIMEOUT_MS);
    const params = seconds ? { cfg } : { cfg, runTimeoutMs, model: cloud };
    expectBudgets(params, seconds ? 30_000 : 120_000);
  });

  it.each([
    ["http://localhost:11434", 0],
    ["http://100.64.0.5:11434", 0],
    ["http://[fe80::1]:11434", 0],
    ["http://172.32.0.1:11434", 120_000],
    ["http://192.169.1.1:11434", 120_000],
    ["http://[::ffff:126.255.255.255]:11434", 120_000],
    ["http://[::ffff:128.0.0.0]:11434", 120_000],
  ])("classifies the endpoint without DNS: %s", (baseUrl, expected) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(expected);
  });

  it.each`
    name                         | params                                                                                                           | expected   | cron
    ${"local marker"}            | ${configured({ gpu: "custom-local" }, "gpu")}                                                                    | ${300_000} | ${600_000}
    ${"unconfigured proxy"}      | ${{ model: { provider: "custom-proxy", baseUrl: "http://gateway:4000/v1" } }}                                    | ${120_000} | ${60_000}
    ${"normalized key"}          | ${configured({ " GPU ": "custom-local" })}                                                                       | ${300_000} | ${undefined}
    ${"canonical key priority"}  | ${configured({ " GPU ": "custom-local", gpu: "synthetic-remote" })}                                              | ${120_000} | ${undefined}
    ${"first normalized key"}    | ${configured({ " GPU ": "synthetic-remote", GPU: "custom-local" })}                                              | ${120_000} | ${undefined}
    ${"remote loopback"}         | ${configured({ gpu: "synthetic-remote" }, "gpu", { remote: true, baseUrl: "http://127.0.0.1:8787" })}            | ${120_000} | ${60_000}
    ${"remote local marker"}     | ${configured({ gpu: "custom-local" }, "gpu", { remote: true })}                                                  | ${120_000} | ${60_000}
    ${"remote local service"}    | ${configured({ gpu: "synthetic-remote" }, "gpu", { remote: true, localService: { command: "/usr/bin/relay" } })} | ${120_000} | ${60_000}
    ${"self-hosted provider"}    | ${configured({ "ollama-relay": "synthetic-remote" }, "ollama-relay")}                                            | ${300_000} | ${600_000}
    ${"explicit local provider"} | ${configured({ "ollama-relay": "synthetic-remote" }, "ollama-relay", { remote: false })}                         | ${300_000} | ${600_000}
    ${"remote self-hosted ID"}   | ${configured({ "ollama-relay": "synthetic-remote" }, "ollama-relay", { remote: true })}                          | ${120_000} | ${60_000}
  `("uses $name for configured provider locality", ({ params, expected, cron }: LocalityCase) => {
    expectBudgets(params, expected);
    if (cron !== undefined) {
      expect(resolveLlmIdleTimeoutMs({ ...params, trigger: "cron", runTimeoutMs: 600_000 })).toBe(
        cron,
      );
    }
  });

  it("keeps explicit provider timeoutSeconds ahead of the remote hint", () => {
    const params = {
      ...configured({ relay: "synthetic-remote" }, "relay", { remote: true }),
      modelRequestTimeoutMs: 900_000,
    };
    expectBudgets(params, 900_000);
    expectBudgets({ ...params, trigger: "cron", runTimeoutMs: 600_000 }, 600_000);
    expectBudgets({ ...params, runTimeoutMs: 20_000 }, 20_000);
  });

  it.each([
    ["kimi-k2.5:cloud", "http://127.0.0.1:11434", 0],
    ["kimi-k2.5:cloud", "http://[::ffff:127.0.0.2]:11434", 0],
    ["gpt-oss:120b-cloud", "http://ollama-box:11434", 300_000],
  ])("keeps hosted watchdogs for custom Ollama model %s through %s", (id, baseUrl, localIdle) => {
    const { cfg } = configured({ "local-ollama": "ollama-local" }, "local-ollama", { baseUrl });
    const model = { provider: "local-ollama", id, baseUrl };
    expect({
      idle: resolveLlmIdleTimeoutMs({ cfg, model }),
      firstEvent: resolveLlmFirstEventTimeoutMs({ cfg, model }),
      cron: resolveLlmIdleTimeoutMs({ cfg, model, trigger: "cron", runTimeoutMs: 600_000 }),
      local: resolveLlmIdleTimeoutMs({ cfg, model: { ...model, id: "gemma4:latest" } }),
    }).toEqual({ idle: 120_000, firstEvent: 120_000, cron: 60_000, local: localIdle });
  });
});
