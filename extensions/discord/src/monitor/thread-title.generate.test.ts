import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  resolveAgentDirMock: vi.fn(),
  resolveAgentEffectiveModelPrimaryMock: vi.fn(),
  discoverAuthStorageMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  findModelMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  extractAssistantTextMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: hoisted.completeMock,
}));

vi.mock("../../../../src/agents/agent-scope.js", () => ({
  resolveAgentDir: hoisted.resolveAgentDirMock,
  resolveAgentEffectiveModelPrimary: hoisted.resolveAgentEffectiveModelPrimaryMock,
}));

vi.mock("../../../../src/agents/pi-model-discovery.js", () => ({
  discoverAuthStorage: hoisted.discoverAuthStorageMock,
  discoverModels: hoisted.discoverModelsMock,
}));

vi.mock("../../../../src/agents/model-auth.js", () => ({
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
}));

vi.mock("../../../../src/agents/pi-embedded-utils.js", () => ({
  extractAssistantText: hoisted.extractAssistantTextMock,
}));

vi.mock("../../../github-copilot/token.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

import { generateThreadTitle } from "./thread-title.js";

beforeEach(() => {
  hoisted.completeMock.mockReset();
  hoisted.resolveAgentDirMock.mockReset();
  hoisted.resolveAgentEffectiveModelPrimaryMock.mockReset();
  hoisted.discoverAuthStorageMock.mockReset();
  hoisted.discoverModelsMock.mockReset();
  hoisted.findModelMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.extractAssistantTextMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();

  hoisted.resolveAgentDirMock.mockReturnValue("/tmp/openclaw-agent");
  hoisted.resolveAgentEffectiveModelPrimaryMock.mockReturnValue("anthropic/claude-opus-4-6");
  hoisted.discoverAuthStorageMock.mockReturnValue({
    setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
  });
  hoisted.discoverModelsMock.mockReturnValue({
    find: hoisted.findModelMock,
  });
  hoisted.findModelMock.mockReturnValue({
    provider: "anthropic",
    id: "claude-opus-4-6",
  });
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    mode: "api-key",
    source: "env:TEST_API_KEY",
  });
  hoisted.completeMock.mockResolvedValue({});
  hoisted.extractAssistantTextMock.mockReturnValue("Generated title");
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    token: "copilot-token",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    baseUrl: "https://api.individual.githubcopilot.com",
  });
});

describe("generateThreadTitle", () => {
  it("continues when auth mode is aws-sdk and api key is absent", async () => {
    hoisted.resolveAgentEffectiveModelPrimaryMock.mockReturnValue(
      "amazon-bedrock/anthropic.claude-sonnet-4-5",
    );
    hoisted.findModelMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "anthropic.claude-sonnet-4-5",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    hoisted.extractAssistantTextMock.mockReturnValue("Bedrock generated title");

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Summarize the deployment blockers.",
    });

    expect(result).toBe("Bedrock generated title");
    expect(hoisted.completeMock).toHaveBeenCalledTimes(1);
    const completeOptions = hoisted.completeMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(completeOptions).toEqual(
      expect.objectContaining({
        maxTokens: 24,
        temperature: 0.2,
      }),
    );
    expect("apiKey" in completeOptions).toBe(false);
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns null when api key is missing for non-aws auth modes", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      mode: "api-key",
      source: "models.providers.anthropic",
    });

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(hoisted.completeMock).not.toHaveBeenCalled();
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges GitHub token for Copilot token before completion", async () => {
    hoisted.resolveAgentEffectiveModelPrimaryMock.mockReturnValue("github-copilot/gpt-4.1");
    hoisted.findModelMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-4.1",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "ghu_test",
      mode: "token",
      source: "profile:github-copilot",
    });
    hoisted.extractAssistantTextMock.mockReturnValue("Copilot title");

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Generate a summary title.",
    });

    expect(result).toBe("Copilot title");
    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("github-copilot", "copilot-token");
    const completeOptions = hoisted.completeMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect("apiKey" in completeOptions).toBe(false);
  });
});
