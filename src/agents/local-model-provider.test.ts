import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { LocalModelSecurityConfig } from "../config/types.local-model-security.js";
import {
  filterCloudProviders,
  getDefaultLocalBaseUrl,
  isLocalBaseUrl,
  resolveLocalProviders,
} from "./local-model-provider.js";

describe("isLocalBaseUrl", () => {
  it("accepts loopback addresses", () => {
    expect(isLocalBaseUrl("http://localhost:11434")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalBaseUrl("http://[::1]:11434")).toBe(true);
  });

  it("accepts .local domains (mDNS)", () => {
    expect(isLocalBaseUrl("http://ollama-server.local:11434")).toBe(true);
  });

  it("accepts .lan domains", () => {
    expect(isLocalBaseUrl("http://model-server.lan:8000")).toBe(true);
  });

  it("accepts .internal domains", () => {
    expect(isLocalBaseUrl("http://ai.internal:11434")).toBe(true);
  });

  it("accepts RFC 1918 private IP addresses", () => {
    expect(isLocalBaseUrl("http://192.168.1.100:11434")).toBe(true);
    expect(isLocalBaseUrl("http://10.0.0.5:8000")).toBe(true);
    expect(isLocalBaseUrl("http://172.16.0.10:11434")).toBe(true);
  });

  it("rejects public hostnames", () => {
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalBaseUrl("https://api.anthropic.com/v1")).toBe(false);
  });

  it("rejects public IP addresses", () => {
    expect(isLocalBaseUrl("http://8.8.8.8:11434")).toBe(false);
  });

  it("handles invalid URLs", () => {
    expect(isLocalBaseUrl("not-a-url")).toBe(false);
    expect(isLocalBaseUrl("")).toBe(false);
  });
});

describe("filterCloudProviders", () => {
  it("passes through all providers when mode is off", () => {
    const providers = {
      openai: { baseUrl: "https://api.openai.com/v1", models: [] },
      ollama: { baseUrl: "http://127.0.0.1:11434", models: [] },
    };
    const result = filterCloudProviders(providers, undefined);
    expect(Object.keys(result)).toEqual(["openai", "ollama"]);
  });

  it("filters cloud providers in enforced mode", () => {
    const providers = {
      openai: { baseUrl: "https://api.openai.com/v1", models: [] },
      anthropic: { baseUrl: "https://api.anthropic.com/v1", models: [] },
      ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama" as const, models: [] },
      local: { baseUrl: "http://192.168.1.100:8000/v1", models: [] },
    };
    const config: LocalModelSecurityConfig = { mode: "enforced" };
    const result = filterCloudProviders(providers, config);
    expect(Object.keys(result)).toEqual(["ollama", "local"]);
  });

  it("keeps cloud providers in audit mode (with logging)", () => {
    const providers = {
      openai: { baseUrl: "https://api.openai.com/v1", models: [] },
      ollama: { baseUrl: "http://127.0.0.1:11434", models: [] },
    };
    const config: LocalModelSecurityConfig = { mode: "audit" };
    const result = filterCloudProviders(providers, config);
    expect(Object.keys(result)).toEqual(["openai", "ollama"]);
  });

  it("respects blockCloudProviders: false", () => {
    const providers = {
      openai: { baseUrl: "https://api.openai.com/v1", models: [] },
    };
    const config: LocalModelSecurityConfig = { mode: "enforced", blockCloudProviders: false };
    const result = filterCloudProviders(providers, config);
    expect(Object.keys(result)).toEqual(["openai"]);
  });
});

describe("resolveLocalProviders", () => {
  it("returns empty when mode is off", async () => {
    const result = await resolveLocalProviders(undefined);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns empty when no local providers are configured", async () => {
    const config: OpenClawConfig = {
      localModelSecurity: { mode: "enforced" },
    };
    const result = await resolveLocalProviders(config);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("resolves an Ollama provider", async () => {
    const config: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [{ type: "ollama", baseUrl: "http://127.0.0.1:11434", name: "my-ollama" }],
      },
    };
    const result = await resolveLocalProviders(config);
    // Model discovery is skipped in test mode, so models will be empty.
    expect(result).toHaveProperty("local-ollama-my-ollama");
    expect(result["local-ollama-my-ollama"]?.api).toBe("ollama");
    expect(result["local-ollama-my-ollama"]?.baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("resolves a vLLM provider", async () => {
    const config: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [{ type: "vllm", baseUrl: "http://192.168.1.50:8000/v1" }],
      },
    };
    const result = await resolveLocalProviders(config);
    expect(result).toHaveProperty("local-vllm-default");
    expect(result["local-vllm-default"]?.api).toBe("openai-completions");
  });

  it("blocks non-local URLs in enforced mode", async () => {
    const config: OpenClawConfig = {
      localModelSecurity: {
        mode: "enforced",
        localProviders: [{ type: "ollama", baseUrl: "https://api.external-cloud.com:11434" }],
      },
    };
    const result = await resolveLocalProviders(config);
    // Non-local URL should be rejected.
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("getDefaultLocalBaseUrl", () => {
  it("returns correct defaults for each provider type", () => {
    expect(getDefaultLocalBaseUrl("ollama")).toBe("http://127.0.0.1:11434");
    expect(getDefaultLocalBaseUrl("vllm")).toBe("http://127.0.0.1:8000/v1");
    expect(getDefaultLocalBaseUrl("custom-openai")).toBe("http://127.0.0.1:8080/v1");
  });
});
