import { describe, expect, it } from "vitest";
import { applyDetectedLlmToConfig, detectLlmProviderFromEnv } from "./direct-llm-bridge.js";
import { INIT_PROFILES, collectClaworksInitWarnings } from "./init-cli.js";

describe("detectLlmProviderFromEnv", () => {
  it("detects OpenAI", () => {
    const detected = detectLlmProviderFromEnv({ OPENAI_API_KEY: "sk-test" });
    expect(detected?.provider).toBe("OpenAI");
  });

  it("detects Ollama", () => {
    const detected = detectLlmProviderFromEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" });
    expect(detected?.provider).toBe("Ollama");
  });

  it("detects Anthropic when OpenAI key absent", () => {
    const detected = detectLlmProviderFromEnv({ ANTHROPIC_API_KEY: "ant-test" });
    expect(detected?.provider).toBe("Anthropic");
  });
});

describe("applyDetectedLlmToConfig", () => {
  it("writes model_router on claworks-robot config", () => {
    const config = {
      plugins: {
        entries: {
          "claworks-robot": { config: {} },
        },
      },
    };
    const detected = detectLlmProviderFromEnv({ OPENAI_API_KEY: "sk-test" });
    expect(detected).not.toBeNull();
    expect(applyDetectedLlmToConfig(config, detected!)).toBe(true);
    const router = config.plugins.entries["claworks-robot"].config.model_router as Record<
      string,
      string
    >;
    expect(router.default).toContain("openai/");
  });
});

describe("INIT_PROFILES", () => {
  it("includes enterprise industrial daily-report", () => {
    expect(INIT_PROFILES).toEqual(["industrial", "enterprise", "daily-report"]);
  });
});

describe("collectClaworksInitWarnings", () => {
  it("warns when echo demo connector is enabled", () => {
    const warnings = collectClaworksInitWarnings({
      plugins: {
        entries: {
          "claworks-robot": {
            config: {
              connectors: { echo: { enabled: true, preset: "echo" } },
            },
          },
        },
      },
    });
    expect(warnings.some((w) => w.includes("connectors.echo"))).toBe(true);
  });

  it("warns on simulate OT connectors outside production mode", () => {
    const warnings = collectClaworksInitWarnings({
      plugins: {
        entries: {
          "claworks-robot": {
            config: {
              connectors: { plant: { simulate: true, enabled: true } },
            },
          },
        },
      },
    });
    expect(warnings.some((w) => w.includes("simulate"))).toBe(true);
  });

  it("suggests personal_work repair profile for enterprise init", () => {
    const warnings = collectClaworksInitWarnings(
      { plugins: { entries: { "claworks-robot": { config: {} } } } },
      {},
    );
    expect(
      warnings.some(
        (w) => w.includes("personal_work") && w.includes("claworks-personal.env.example"),
      ),
    ).toBe(true);
  });

  it("warns when production_mode and echo connector both enabled", () => {
    const warnings = collectClaworksInitWarnings({
      plugins: {
        entries: {
          "claworks-robot": {
            config: {
              production_mode: true,
              connectors: { echo: { enabled: true, preset: "echo" } },
            },
          },
        },
      },
    });
    expect(warnings.some((w) => w.includes("production_mode") && w.includes("echo"))).toBe(true);
  });
});

// loadPackProfileIds is not exported - test via re-export or inline
describe("init profile pack resolution", () => {
  it("rejects unknown profile at runtime", async () => {
    const { runClaworksInit } = await import("./init-cli.js");
    await expect(runClaworksInit({ profile: "unknown", skipProfileEvent: true })).rejects.toThrow(
      /无效 profile/,
    );
  });
});
