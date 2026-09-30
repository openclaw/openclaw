import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

const DEFAULT_LLM_IDLE_TIMEOUT_MS = 120_000;
const SELF_HOSTED_LLM_IDLE_TIMEOUT_MS = 300_000;
const CRON_LLM_IDLE_TIMEOUT_MS = 60_000;
const CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = DEFAULT_LLM_IDLE_TIMEOUT_MS;
const LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS = 300_000;

describe("resolveLlmIdleTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveLlmIdleTimeoutMs()).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("returns default when agent defaults are missing", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("caps agents.defaults.timeoutSeconds fallback at the default idle watchdog", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("uses agents.defaults.timeoutSeconds when it is shorter than the default idle watchdog", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 30 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg })).toBe(30_000);
  });

  it("caps an explicit run timeout override at the default idle watchdog", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 900_000 })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("uses an explicit run timeout override when shorter than the default idle watchdog", () => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 30_000 })).toBe(30_000);
  });

  it.each([
    [
      "cloud",
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    ],
    [
      "self-hosted",
      { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      SELF_HOSTED_LLM_IDLE_TIMEOUT_MS,
    ],
  ])("uses the provider-class idle default for no-timeout %s models", (_label, model, expected) => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: MAX_TIMER_TIMEOUT_MS, model })).toBe(expected);
  });

  it("keeps local base URLs opted out of the implicit idle watchdog under no-timeout runs", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS,
        model: { baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(0);
  });

  it("caps explicit cron run timeouts so stream stalls can reach model fallbacks", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron", runTimeoutMs: 600_000 })).toBe(
      CRON_LLM_IDLE_TIMEOUT_MS,
    );
  });

  it("uses shorter explicit cron run timeouts as the idle watchdog ceiling", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron", runTimeoutMs: 30_000 })).toBe(30_000);
  });

  it("honors explicit cron run timeouts for local provider model calls", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(600_000);
  });

  it.each([
    ["ollama", "http://ollama-host:11434"],
    ["ollama-beelink", "http://ollama-host:11434"],
    ["lmstudio", "http://lmstudio-box:1234/v1"],
    ["lmstudio-mac", "http://lmstudio-box:1234/v1"],
    ["vllm", "http://vllm-rig:8000/v1"],
    ["sglang", "http://sglang-rig:30000/v1"],
  ])(
    "honors explicit cron run timeouts for self-hosted provider %s hostname %s",
    (provider, baseUrl) => {
      expect(
        resolveLlmIdleTimeoutMs({
          trigger: "cron",
          runTimeoutMs: 600_000,
          model: { provider, baseUrl },
        }),
      ).toBe(600_000);
    },
  );

  it("honors explicit cron run timeouts for explicit local host aliases", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { baseUrl: "http://host.docker.internal:11434" },
      }),
    ).toBe(600_000);
  });

  it("honors explicit cron run timeouts for custom local provider markers on bare hostnames", () => {
    const cfg = {
      models: {
        providers: {
          gpu: {
            baseUrl: "http://gpu-box:8000/v1",
            api: "openai-completions",
            apiKey: "custom-local",
            models: [],
          },
          "local-ollama": {
            baseUrl: "http://ollama-box:11434",
            api: "ollama",
            apiKey: "ollama-local",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { provider: "gpu", baseUrl: "http://gpu-box:8000/v1" },
      }),
    ).toBe(600_000);
    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { provider: "local-ollama", baseUrl: "http://ollama-box:11434" },
      }),
    ).toBe(600_000);
  });

  it("honors explicit cron run timeouts for provider-owned local services on bare hostnames", () => {
    const cfg = {
      models: {
        providers: {
          ds4: {
            baseUrl: "http://ds4-box:8000/v1",
            api: "openai-completions",
            localService: {
              command: "/opt/ds4/ds4-server",
              healthUrl: "http://ds4-box:8000/v1/models",
            },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { provider: "ds4", baseUrl: "http://ds4-box:8000/v1" },
      }),
    ).toBe(600_000);
  });

  it.each([
    ["openai", "openai/gpt-5.5", "http://api:8080/v1"],
    ["custom-proxy", "custom-proxy/gpt-5.5", "http://gateway:4000/v1"],
    ["ollama-cloud", "ollama-cloud/kimi-k2.6", "http://ollama-host:11434"],
  ])(
    "keeps the cron stall cap for cloud provider %s routed through single-label host %s",
    (provider, id, baseUrl) => {
      expect(
        resolveLlmIdleTimeoutMs({
          trigger: "cron",
          runTimeoutMs: 600_000,
          model: { provider, id, baseUrl },
        }),
      ).toBe(CRON_LLM_IDLE_TIMEOUT_MS);
    },
  );

  it("keeps the cron stall cap for remote or cloud hostnames", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { provider: "openai", id: "openai/gpt-5.5", baseUrl: "https://api.openai.com/v1" },
      }),
    ).toBe(CRON_LLM_IDLE_TIMEOUT_MS);
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 600_000,
        model: { provider: "ollama", id: "ollama/gpt-oss:cloud", baseUrl: "http://ollama-host" },
      }),
    ).toBe(CRON_LLM_IDLE_TIMEOUT_MS);
  });

  it("honors an explicit models.providers.<id>.timeoutSeconds for cloud providers (#77744, #78361)", () => {
    // models.providers.<id>.timeoutSeconds is documented as the user-facing
    // knob to extend slow model responses. The idle watchdog must respect it
    // instead of clamping back to DEFAULT_LLM_IDLE_TIMEOUT_MS.
    expect(resolveLlmIdleTimeoutMs({ modelRequestTimeoutMs: 300_000 })).toBe(300_000);
  });

  it("honors explicit provider timeouts for self-hosted bare hostnames", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        model: { baseUrl: "http://cerebro-mac:8080/v1" },
        modelRequestTimeoutMs: 600_000,
      }),
    ).toBe(600_000);
  });

  it("honors short explicit provider request timeouts", () => {
    expect(resolveLlmIdleTimeoutMs({ modelRequestTimeoutMs: 30_000 })).toBe(30_000);
  });

  it("caps provider request timeout at the max safe timeout", () => {
    expect(
      resolveLlmIdleTimeoutMs({ trigger: "cron", modelRequestTimeoutMs: 10_000_000_000 }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores invalid provider request timeout values", () => {
    expect(resolveLlmIdleTimeoutMs({ modelRequestTimeoutMs: -1 })).toBe(
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    );
    expect(resolveLlmIdleTimeoutMs({ modelRequestTimeoutMs: Infinity })).toBe(
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    );
  });

  it("bounds provider request timeout by agents.defaults.timeoutSeconds when shorter", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 45 } },
    } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, modelRequestTimeoutMs: 300_000 })).toBe(45_000);
  });

  it("bounds provider request timeout by explicit run timeout when shorter", () => {
    expect(resolveLlmIdleTimeoutMs({ modelRequestTimeoutMs: 300_000, runTimeoutMs: 45_000 })).toBe(
      45_000,
    );
  });

  it("does not bound explicit run timeout by agents.defaults.timeoutSeconds", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 45 } },
    } as OpenClawConfig;
    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        modelRequestTimeoutMs: 300_000,
        runTimeoutMs: 180_000,
      }),
    ).toBe(180_000);
  });

  it("honors provider request timeout when run timeout is the NO_TIMEOUT sentinel", () => {
    // Regression: when `runTimeoutSeconds` is treated as 0, `resolveAgentTimeoutMs`
    // hands back the max timer sentinel. An explicit per-model idle timeout
    // must still take effect: "run is unlimited" does not imply "skip
    // chunk-level hang detection".
    expect(
      resolveLlmIdleTimeoutMs({
        modelRequestTimeoutMs: 180_000,
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    ).toBe(180_000);
  });

  it("does not bound provider request timeout by agent default when run timeout is no-timeout", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 45 } },
    } as OpenClawConfig;
    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        modelRequestTimeoutMs: 180_000,
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    ).toBe(180_000);
  });

  it("keeps the cloud idle watchdog finite when config timeoutSeconds is unlimited", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 0 } } } as OpenClawConfig;
    const runTimeoutMs = resolveAgentTimeoutMs({ cfg });

    expect(runTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveLlmIdleTimeoutMs({
        cfg,
        runTimeoutMs,
        model: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      }),
    ).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it.each([
    ["vllm", "https://gpu.example.com/v1"],
    ["sglang-rig", "https://llm.example.net/v1"],
    ["lmstudio", "http://llm.example.net/v1"],
  ])("uses the self-hosted idle default for provider %s at %s", (provider, baseUrl) => {
    expect(resolveLlmIdleTimeoutMs({ model: { provider, baseUrl } })).toBe(
      SELF_HOSTED_LLM_IDLE_TIMEOUT_MS,
    );
  });

  it("keeps the cloud provider idle default unchanged", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        model: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      }),
    ).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("uses provider request timeout for cron model calls", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron", modelRequestTimeoutMs: 300_000 })).toBe(
      300_000,
    );
  });

  it("uses the default idle timeout for cron cloud model calls when no timeout is configured", () => {
    expect(resolveLlmIdleTimeoutMs({ trigger: "cron" })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);

    const cfg = { agents: { defaults: {} } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("caps agents.defaults.timeoutSeconds for cron before disabling the default idle timeout", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 300 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, trigger: "cron" })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("keeps cron local provider model calls opted out of the implicit idle watchdog", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        model: { baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(0);
  });

  it.each([
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://127.0.0.2:11434",
    "http://127.255.255.254:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://my-rig.local:11434",
    "http://10.0.0.5:11434",
    "http://172.16.5.10:11434",
    "http://172.31.99.1:11434",
    "http://192.168.1.20:11434",
    "http://100.64.0.5:11434",
    "http://100.127.255.254:11434",
    // RFC 4193 IPv6 unique local (Tailscale IPv6 mesh fd7a:115c:a1e0::/48
    // falls inside fc00::/7).
    "http://[fc00::1]:11434",
    "http://[fd00::1]:11434",
    "http://[fd7a:115c:a1e0::dead:beef]:11434",
    "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:11434",
    // RFC 4291 IPv6 link-local.
    "http://[fe80::1]:11434",
    "http://[fe9a::1]:11434",
    "http://[feab:cd::1]:11434",
    "http://[febf::1]:11434",
  ])("disables the default idle watchdog for local provider baseUrl %s", (baseUrl) => {
    // Local/self-hosted providers can run much slower than hosted APIs, so the
    // default idle watchdog is disabled unless an explicit timeout is present.
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(0);
  });

  it("keeps the default idle watchdog for Ollama cloud models routed through local Ollama", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        model: {
          provider: "ollama",
          id: "glm-5.1:cloud",
          baseUrl: "http://127.0.0.1:11434",
        },
      }),
    ).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
    expect(
      resolveLlmIdleTimeoutMs({
        model: {
          provider: "ollama2",
          id: "ollama2/kimi-k2.5:cloud",
          baseUrl: "http://localhost:11434",
        },
      }),
    ).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
    expect(
      resolveLlmIdleTimeoutMs({
        model: {
          provider: "ollama",
          id: "ollama/gpt-oss:120b-cloud",
          baseUrl: "http://127.0.0.1:11434",
        },
      }),
    ).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it.each([
    ["kimi-k2.5:cloud", "http://127.0.0.1:11434", 0],
    ["gpt-oss:120b-cloud", "http://127.0.0.1:11434", 0],
    ["kimi-k2.5:cloud", "http://ollama-box:11434", SELF_HOSTED_LLM_IDLE_TIMEOUT_MS],
    ["gpt-oss:120b-cloud", "http://ollama-box:11434", SELF_HOSTED_LLM_IDLE_TIMEOUT_MS],
  ])(
    "keeps hosted watchdogs for custom Ollama model %s through %s",
    (id, baseUrl, localIdleTimeoutMs) => {
      const providerConfig = { api: "ollama", apiKey: "ollama-local", baseUrl, models: [] };
      const cfg = { models: { providers: { "local-ollama": providerConfig } } } as OpenClawConfig;
      const model = { provider: "local-ollama", id, baseUrl };

      expect({
        idle: resolveLlmIdleTimeoutMs({ cfg, model }),
        firstEvent: resolveLlmFirstEventTimeoutMs({ cfg, model }),
        cron: resolveLlmIdleTimeoutMs({ cfg, trigger: "cron", runTimeoutMs: 600_000, model }),
        local: resolveLlmIdleTimeoutMs({ cfg, model: { ...model, id: "gemma4:latest" } }),
      }).toEqual({
        idle: DEFAULT_LLM_IDLE_TIMEOUT_MS,
        firstEvent: CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS,
        cron: CRON_LLM_IDLE_TIMEOUT_MS,
        local: localIdleTimeoutMs,
      });
    },
  );

  it.each([
    "http://172.32.0.1:11434",
    "http://192.169.1.1:11434",
    "http://100.63.255.254:11434",
    "http://100.128.0.1:11434",
  ])("keeps the default idle watchdog for non-private IPv4 baseUrl %s", (baseUrl) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  // Node's URL parser normalizes every IPv4-mapped loopback form
  // (`::ffff:127.0.0.1`, `::ffff:7F00:1`, mixed case, …) to the canonical
  // `::ffff:7f00:1`. Exercise the user-facing input shapes here so the full
  // parse → lowercase → bracket-strip → exact-match chain is regression-tested
  // against future URL parser behavior, not just the canonical literal.
  it.each([
    "http://[::ffff:127.0.0.1]:11434",
    "http://[::ffff:7f00:1]:11434",
    "http://[::FFFF:127.0.0.1]:11434",
  ])("disables the default idle watchdog for IPv4-mapped loopback baseUrl %s", (baseUrl) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(0);
  });

  it.each([
    // Just outside fc00::/7 (fe.. and 00fc::/16 are not unique-local).
    "http://[fec0::1]:11434",
    "http://[fbff::1]:11434",
    // Just outside fe80::/10 (fec0:: was deprecated site-local, fe7f:: not LL).
    "http://[fe7f::1]:11434",
    // Public IPv6.
    "http://[2001:db8::1]:11434",
    // Abbreviated `fc::1` expands to 00fc:0:0:...:1, first byte is 0x00, not
    // 0xfc — outside fc00::/7. Strict first-hextet match keeps this remote.
    "http://[fc::1]:11434",
    // IPv4-mapped IPv6 outside loopback (private RFC 1918 in mapped form is
    // intentionally not matched, mirroring the SSRF policy helper).
    "http://[::ffff:10.0.0.5]:11434",
    "http://[::ffff:192.168.1.20]:11434",
  ])("keeps the default idle watchdog for non-private IPv6 baseUrl %s", (baseUrl) => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it.each([
    "http://10.0.0.5evil:11434",
    "http://127.0.0.1foo:11434",
    "http://192.168.1.20attacker.com:11434",
    "http://10.0.0.5.evil.com:11434",
    "http://1.2.3.4.5:11434",
  ])(
    "keeps the default idle watchdog for numeric-looking hostnames that are not IPv4 literals (%s)",
    (baseUrl) => {
      expect(resolveLlmIdleTimeoutMs({ model: { baseUrl } })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
    },
  );

  it("keeps the default idle watchdog for remote provider baseUrls", () => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "https://api.openai.com/v1" } })).toBe(
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    );
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "https://ollama.com" } })).toBe(
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    );
  });

  it("ignores malformed baseUrl and keeps the default idle watchdog", () => {
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "not-a-url" } })).toBe(
      DEFAULT_LLM_IDLE_TIMEOUT_MS,
    );
    expect(resolveLlmIdleTimeoutMs({ model: { baseUrl: "" } })).toBe(DEFAULT_LLM_IDLE_TIMEOUT_MS);
  });

  it("still honors an explicit provider request timeout for local providers", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        model: { baseUrl: "http://127.0.0.1:11434" },
        modelRequestTimeoutMs: 600_000,
      }),
    ).toBe(600_000);
  });

  it("still applies agents.defaults.timeoutSeconds cap for local providers", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 30 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, model: { baseUrl: "http://127.0.0.1:11434" } })).toBe(
      30_000,
    );
  });

  it.each([
    ["local keeps no class ceiling", { baseUrl: "http://127.0.0.1:11434" }, 3_600_000],
    [
      "self-hosted keeps the 300s tier",
      { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      300_000,
    ],
    ["cloud keeps the 120s default", { provider: "openai" }, 120_000],
  ])("large agents.defaults.timeoutSeconds: %s", (_label, model, expected) => {
    const cfg = { agents: { defaults: { timeoutSeconds: 3_600 } } } as OpenClawConfig;
    expect(resolveLlmIdleTimeoutMs({ cfg, model })).toBe(expected);
  });

  it.each([
    ["local keeps no class ceiling", { baseUrl: "http://127.0.0.1:11434" }, 900_000],
    [
      "self-hosted keeps the 300s tier",
      { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      300_000,
    ],
    ["cloud keeps the 120s default", { provider: "openai" }, 120_000],
  ])("explicit run timeout above the tiers: %s", (_label, model, expected) => {
    expect(resolveLlmIdleTimeoutMs({ runTimeoutMs: 900_000, model })).toBe(expected);
  });

  it("explicit run timeouts below the class tier still bound self-hosted idle", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        runTimeoutMs: 90_000,
        model: { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      }),
    ).toBe(90_000);
  });

  it("cron exempts provider-id self-hosted models from the 60s clamp", () => {
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 900_000,
        model: { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      }),
    ).toBe(900_000);
    expect(
      resolveLlmIdleTimeoutMs({
        trigger: "cron",
        runTimeoutMs: 900_000,
        model: { provider: "openai" },
      }),
    ).toBe(60_000);
  });
});

describe("resolveLlmFirstEventTimeoutMs", () => {
  it("uses the cloud first-event timeout by default", () => {
    expect(resolveLlmFirstEventTimeoutMs()).toBe(CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS);
  });

  it("uses the longer local first-event timeout for loopback providers", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
      }),
    ).toBe(LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS);
  });

  it("uses the longer local first-event timeout for self-hosted bare hostnames", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { provider: "vllm", baseUrl: "http://gpu-box:8000/v1" },
      }),
    ).toBe(LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS);
  });

  it("keeps Ollama cloud models on the cloud first-event timeout", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { provider: "ollama", id: "ollama/kimi-k2.6:cloud", baseUrl: "http://127.0.0.1" },
      }),
    ).toBe(CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS);
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: {
          provider: "ollama",
          id: "ollama/gpt-oss:120b-cloud",
          baseUrl: "http://127.0.0.1:11434",
        },
      }),
    ).toBe(CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS);
  });

  it("honors explicit provider request timeouts", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { baseUrl: "http://127.0.0.1:11434" },
        modelRequestTimeoutMs: 600_000,
      }),
    ).toBe(600_000);
  });

  it("caps first-event timeout by explicit run timeout", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { baseUrl: "http://127.0.0.1:11434" },
        runTimeoutMs: 45_000,
      }),
    ).toBe(45_000);
  });

  it("does not treat the no-timeout run sentinel as an unlimited first-event wait", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        model: { baseUrl: "http://127.0.0.1:11434" },
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      }),
    ).toBe(LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS);
  });

  it.each([
    [
      "cloud",
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS,
    ],
    [
      "self-hosted",
      { provider: "vllm", baseUrl: "https://gpu.example.com/v1" },
      LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS,
    ],
  ])(
    "uses the provider-class first-event default for no-timeout %s models",
    (_label, model, expected) => {
      expect(resolveLlmFirstEventTimeoutMs({ runTimeoutMs: MAX_TIMER_TIMEOUT_MS, model })).toBe(
        expected,
      );
    },
  );

  it("honors explicit first-event provider request timeouts under no-timeout runs", () => {
    expect(
      resolveLlmFirstEventTimeoutMs({
        runTimeoutMs: MAX_TIMER_TIMEOUT_MS,
        modelRequestTimeoutMs: 600_000,
        model: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      }),
    ).toBe(600_000);
  });

  it("caps first-event timeout by agents.defaults.timeoutSeconds when no explicit run timeout exists", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 20 } } } as OpenClawConfig;
    expect(
      resolveLlmFirstEventTimeoutMs({
        cfg,
        model: { baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(20_000);
  });
});
