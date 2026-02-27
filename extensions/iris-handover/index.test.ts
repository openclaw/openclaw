import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted to top of file, so AnthropicMock must be defined via vi.hoisted.
// Must use regular function (not arrow) so it can be called with `new`.
const { AnthropicMock } = vi.hoisted(() => {
  const AnthropicMock = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    this._opts = opts;
    this.messages = {
      create: vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "# Handover\n\nConteúdo de teste com mais de 50 chars aqui." },
        ],
        usage: { output_tokens: 100 },
      }),
    };
    return this;
  });
  return { AnthropicMock };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: AnthropicMock }));

import { resolveAnthropicCreds, createAnthropicClient } from "./index.js";

describe("resolveAnthropicCreds", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    AnthropicMock.mockClear();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    // Restore env to saved state
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("sem credencial nenhuma: retorna null", () => {
    expect(resolveAnthropicCreds({})).toBeNull();
  });

  it("config.anthropicAuthToken: mode oauth, SDK recebe apiKey:null", () => {
    const creds = resolveAnthropicCreds({ anthropicAuthToken: "sk-ant-oat01-abc" });
    expect(creds).toMatchObject({ mode: "oauth", authToken: "sk-ant-oat01-abc" });
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: null, authToken: "sk-ant-oat01-abc" });
  });

  it("config.anthropicApiKey com API key real: mode apikey, SDK recebe authToken:null", () => {
    const creds = resolveAnthropicCreds({ anthropicApiKey: "sk-ant-api03-xyz" });
    expect(creds).toMatchObject({ mode: "apikey", apiKey: "sk-ant-api03-xyz" });
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: "sk-ant-api03-xyz", authToken: null });
  });

  it("config.anthropicApiKey com OAuth token: trata como oauth + emite warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const creds = resolveAnthropicCreds({ anthropicApiKey: "sk-ant-oat01-legacy" });
    expect(creds).toMatchObject({ mode: "oauth", authToken: "sk-ant-oat01-legacy" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("legacy oauth"));
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: null, authToken: "sk-ant-oat01-legacy" });
    warnSpy.mockRestore();
  });

  it("ANTHROPIC_AUTH_TOKEN env: mode oauth, SDK recebe apiKey:null", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-fromenv";
    const creds = resolveAnthropicCreds({});
    expect(creds).toMatchObject({ mode: "oauth", source: "ANTHROPIC_AUTH_TOKEN env" });
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: null, authToken: "sk-ant-oat01-fromenv" });
  });

  it("ANTHROPIC_API_KEY com OAuth token: trata como oauth + emite warning", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-badenv";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const creds = resolveAnthropicCreds({});
    expect(creds).toMatchObject({ mode: "oauth", source: expect.stringContaining("legacy oauth") });
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: null, authToken: "sk-ant-oat01-badenv" });
    warnSpy.mockRestore();
  });

  it("ANTHROPIC_API_KEY com API key real: mode apikey, SDK recebe authToken:null", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-real";
    const creds = resolveAnthropicCreds({});
    expect(creds).toMatchObject({ mode: "apikey", apiKey: "sk-ant-api03-real" });
    createAnthropicClient(creds!);
    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: "sk-ant-api03-real", authToken: null });
  });

  it("config explícita tem prioridade sobre env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-env";
    const creds = resolveAnthropicCreds({ anthropicAuthToken: "sk-ant-oat01-config" });
    expect(creds?.source).toContain("config.anthropicAuthToken");
  });

  it("ANTHROPIC_AUTH_TOKEN tem prioridade sobre ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-auth";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-apikey";
    const creds = resolveAnthropicCreds({});
    expect(creds?.source).toBe("ANTHROPIC_AUTH_TOKEN env");
  });

  it("normalização: trim e remoção de CR/LF", () => {
    const creds = resolveAnthropicCreds({ anthropicAuthToken: "  sk-ant-oat01-spaces\r\n  " });
    expect(creds).toMatchObject({ authToken: "sk-ant-oat01-spaces" });
  });
});
