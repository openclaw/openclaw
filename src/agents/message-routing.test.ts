import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMessageRoutingModel } from "./agent-scope.js";

const baseConfig = (routing: unknown): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        model: {
          primary: "vllm/qwen35",
          tasks: { messageRouting: routing },
        },
      },
      list: [],
    },
  }) as unknown as OpenClawConfig;

describe("resolveMessageRoutingModel", () => {
  it("returns undefined when no routing config", () => {
    const cfg = baseConfig(undefined);
    expect(resolveMessageRoutingModel(cfg, "test-agent", "hello world")).toBeUndefined();
  });

  it("matches first matching rule (case-insensitive)", () => {
    const cfg = baseConfig({
      rules: [
        { match: ["code review", "PR", "diff"], model: "github-copilot/claude-sonnet-4.6" },
        { match: ["research", "search"], model: "google-gemini-cli/gemini-3-flash-preview" },
      ],
    });
    expect(
      resolveMessageRoutingModel(cfg, "test-agent", "Please do a code review of this PR"),
    ).toBe("github-copilot/claude-sonnet-4.6");
    expect(resolveMessageRoutingModel(cfg, "test-agent", "Research the topic for me")).toBe(
      "google-gemini-cli/gemini-3-flash-preview",
    );
  });

  it("returns default model when no rule matches", () => {
    const cfg = baseConfig({
      rules: [{ match: ["code review"], model: "github-copilot/claude-sonnet-4.6" }],
      default: "vllm/qwen35",
    });
    expect(resolveMessageRoutingModel(cfg, "test-agent", "what is the weather")).toBe(
      "vllm/qwen35",
    );
  });

  it("returns undefined when no rule matches and no default", () => {
    const cfg = baseConfig({
      rules: [{ match: ["code review"], model: "github-copilot/claude-sonnet-4.6" }],
    });
    expect(resolveMessageRoutingModel(cfg, "test-agent", "what is the weather")).toBeUndefined();
  });

  it("returns default when no rules configured but default set", () => {
    const cfg = baseConfig({
      rules: [],
      default: "vllm/qwen35",
    });
    expect(resolveMessageRoutingModel(cfg, "test-agent", "anything")).toBe("vllm/qwen35");
  });

  it("first rule wins when multiple rules match", () => {
    const cfg = baseConfig({
      rules: [
        { match: ["review"], model: "github-copilot/claude-sonnet-4.6" },
        { match: ["code"], model: "vllm/qwen35" },
      ],
    });
    expect(resolveMessageRoutingModel(cfg, "test-agent", "code review")).toBe(
      "github-copilot/claude-sonnet-4.6",
    );
  });
});
