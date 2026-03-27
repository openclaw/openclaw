import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  completeWithPreparedSimpleCompletionModelMock: vi.fn(),
  prepareSimpleCompletionModelForAgentMock: vi.fn(),
  extractAssistantTextMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    completeWithPreparedSimpleCompletionModel:
      hoisted.completeWithPreparedSimpleCompletionModelMock,
    prepareSimpleCompletionModelForAgent: hoisted.prepareSimpleCompletionModelForAgentMock,
    extractAssistantText: hoisted.extractAssistantTextMock,
  };
});

let generateThreadTitle: typeof import("./thread-title.js").generateThreadTitle;

beforeAll(async () => {
  ({ generateThreadTitle } = await import("./thread-title.js"));
});

beforeEach(() => {
  hoisted.completeWithPreparedSimpleCompletionModelMock.mockReset();
  hoisted.prepareSimpleCompletionModelForAgentMock.mockReset();
  hoisted.extractAssistantTextMock.mockReset();

  hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
    selection: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  });
  hoisted.completeWithPreparedSimpleCompletionModelMock.mockResolvedValue({});
  hoisted.extractAssistantTextMock.mockReturnValue("Generated title");
});

describe("generateThreadTitle", () => {
  it("calls shared one-shot model prep with aws-sdk allowance", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      selection: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-5",
        profileId: "work",
        agentDir: "/tmp/openclaw-agent",
      },
      model: {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-5",
      },
      auth: {
        apiKey: "sk-openrouter",
        source: "profile:work",
        mode: "api-key",
      },
    });
    const cfg = {
      agents: {
        defaults: {
          model: "openrouter/anthropic/claude-sonnet-4-5@work",
        },
      },
    } as OpenClawConfig;

    await generateThreadTitle({
      cfg,
      agentId: "main",
      messageText: "Need a generated title.",
    });

    expect(hoisted.prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("passes model override refs into shared model prep", async () => {
    const cfg = {} as OpenClawConfig;
    await generateThreadTitle({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-4.1-mini@local",
      messageText: "Need a generated title.",
    });

    expect(hoisted.prepareSimpleCompletionModelForAgentMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-4.1-mini@local",
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  });

  it("returns null when shared model prep cannot resolve selection", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValueOnce({
      error: "No model configured for agent main.",
    });

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(hoisted.completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("returns null when shared completion prep fails", async () => {
    hoisted.prepareSimpleCompletionModelForAgentMock.mockResolvedValue({
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
      selection: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        agentDir: "/tmp/openclaw-agent",
      },
    });

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Need a thread title.",
    });

    expect(result).toBeNull();
    expect(hoisted.completeWithPreparedSimpleCompletionModelMock).not.toHaveBeenCalled();
  });

  it("builds contextual prompt and forwards completion options", async () => {
    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Summarize deployment blockers and owner follow-ups.",
      channelName: "release-status",
      channelDescription: "Deploy updates and incident notes",
    });

    expect(result).toBe("Generated title");
    expect(hoisted.completeWithPreparedSimpleCompletionModelMock).toHaveBeenCalledTimes(1);
    expect(
      hoisted.completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context,
    ).toEqual(
      expect.objectContaining({
        systemPrompt:
          "Generate a concise Discord thread title (3-6 words). Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Channel: release-status"),
          }),
        ],
      }),
    );
    expect(
      hoisted.completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.context
        ?.messages?.[0]?.content,
    ).toContain("Channel description: Deploy updates and incident notes");
    expect(
      hoisted.completeWithPreparedSimpleCompletionModelMock.mock.calls[0]?.[0]?.options,
    ).toEqual(
      expect.objectContaining({
        maxTokens: 24,
        temperature: 0.2,
      }),
    );
  });

  it("returns null when completion throws", async () => {
    hoisted.completeWithPreparedSimpleCompletionModelMock.mockRejectedValueOnce(
      new Error("network timeout"),
    );

    const result = await generateThreadTitle({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      messageText: "Generate title.",
    });

    expect(result).toBeNull();
  });
});
