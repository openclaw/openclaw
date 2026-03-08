import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type TextPromptConfig = {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
};

function createApi() {
  const providers: any[] = [];
  const api = {
    registerProvider(provider: any) {
      providers.push(provider);
    },
  };
  plugin.register(api as any);
  return providers;
}

function createContext(answers: string[]) {
  const prompts: TextPromptConfig[] = [];
  let index = 0;
  return {
    ctx: {
      prompter: {
        text: async (config: TextPromptConfig) => {
          prompts.push(config);
          return answers[index++] ?? "";
        },
      },
    },
    prompts,
  };
}

describe("crust-proxy plugin", () => {
  it("registers OpenAI-compatible and Anthropic providers", () => {
    const providers = createApi();

    expect(providers.map((provider) => provider.id)).toEqual(["crust-openai", "crust-anthropic"]);
  });

  it("configures OpenAI-compatible routing with Kimi available in defaults", async () => {
    const providers = createApi();
    const provider = providers.find((entry) => entry.id === "crust-openai");
    expect(provider).toBeTruthy();

    const { ctx, prompts } = createContext(["http://localhost:9090", "sk-openai-test", ""]);
    const result = await provider.auth[0].run(ctx as any);

    expect(prompts[2]?.placeholder).toContain("kimi-k2.5");
    expect(result.defaultModel).toBe("crust-openai/gpt-5.2");
    expect(
      result.configPatch.models.providers["crust-openai"].models.map((m: any) => m.id),
    ).toEqual([
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5-mini",
      "claude-sonnet-4.5",
      "gemini-3-flash",
      "kimi-k2.5",
    ]);
    expect(prompts[2]?.validate?.(" , , ")).toBe("Enter at least one model id");
    expect(prompts[2]?.validate?.("")).toBeUndefined();
  });

  it("supports custom OpenAI-compatible model lists", async () => {
    const providers = createApi();
    const provider = providers.find((entry) => entry.id === "crust-openai");
    const { ctx } = createContext([
      "http://localhost:9090",
      "sk-openai-test",
      "kimi-k2.5, qwen3-coder",
    ]);
    const result = await provider.auth[0].run(ctx as any);

    expect(result.defaultModel).toBe("crust-openai/kimi-k2.5");
    expect(
      result.configPatch.models.providers["crust-openai"].models.map((m: any) => m.id),
    ).toEqual(["kimi-k2.5", "qwen3-coder"]);
  });

  it("marks reasoning models conservatively for custom model ids", async () => {
    const providers = createApi();
    const provider = providers.find((entry) => entry.id === "crust-openai");
    const { ctx } = createContext([
      "http://localhost:9090",
      "sk-openai-test",
      "proto3-demo, o3-mini",
    ]);
    const result = await provider.auth[0].run(ctx as any);
    const models = result.configPatch.models.providers["crust-openai"].models;

    expect(models.find((model: any) => model.id === "proto3-demo")?.reasoning).toBe(false);
    expect(models.find((model: any) => model.id === "o3-mini")?.reasoning).toBe(true);
  });

  it("falls back to default Anthropic routing values", async () => {
    const providers = createApi();
    const provider = providers.find((entry) => entry.id === "crust-anthropic");
    const { ctx } = createContext(["", "sk-anthropic-test", ""]);
    const result = await provider.auth[0].run(ctx as any);

    expect(result.defaultModel).toBe("crust-anthropic/claude-sonnet-4.5");
    expect(result.configPatch.models.providers["crust-anthropic"].baseUrl).toBe(
      "http://localhost:9090",
    );
    expect(
      result.configPatch.models.providers["crust-anthropic"].models.map((m: any) => m.id),
    ).toEqual(["claude-sonnet-4.5", "claude-opus-4.5", "claude-haiku-4.5"]);
  });
});
