import { describe, expect, it } from "vitest";
import { buildOllamaBaseUrlSsrFPolicy } from "./provider-models.js";

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it("pins requests to the configured Ollama hostname for HTTP(S) URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      hostnameAllowlist: ["ollama.example.com"],
    });
  });

  it("only opts into private-network access for loopback hosts", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://localhost:11434")).toEqual({
      hostnameAllowlist: ["localhost"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://192.168.1.10:11434")).toEqual({
      hostnameAllowlist: ["192.168.1.10"],
    });
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("not-a-url")).toBeUndefined();
  });
});
