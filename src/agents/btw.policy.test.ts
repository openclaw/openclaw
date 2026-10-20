import { describe, expect, it } from "vitest";
import {
  createSessionEntry,
  mockArg,
  mockOpenAIPlatformProfile,
  registerCodexSideQuestionHarness,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  runSideQuestion,
  setupBtwTestHooks,
} from "./btw.test-support.js";

function createOpenAIModel() {
  return {
    provider: "openai",
    id: "gpt-5.5",
    api: "openai-responses" as const,
    baseUrl: "https://api.openai.com/v1",
  };
}

describe("BTW prepared tool policy", () => {
  setupBtwTestHooks();

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness();
    mockOpenAIPlatformProfile();
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    await runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": {
                toolsBySender: {
                  "id:restricted-sender": { deny: ["*"] },
                },
              },
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({
      toolsAllow: [],
      preparedWebSearchPolicy: {
        allowed: false,
        persistentAllowed: true,
        modelRef: { provider: "openai", model: "gpt-5.5" },
      },
    });
  });

  it.each([true, false])(
    "prepares search for native side-question ownership with a known model: %s",
    async (known) => {
      const codexSideQuestionMock = registerCodexSideQuestionHarness({
        resolveSessionRuntimeOwnershipAsync: async () => ({
          model: "native",
          auth: "native",
          ...(known ? { modelRef: { provider: "openai", model: "native-search-denied" } } : {}),
        }),
      });
      mockOpenAIPlatformProfile();
      resolveModelWithRegistryMock.mockReturnValue(createOpenAIModel());
      resolveModelAsyncMock.mockResolvedValue({ model: createOpenAIModel() });
      await runSideQuestion({
        provider: "openai",
        model: "gpt-5.5",
        cfg: { tools: { byProvider: { "openai/native-search-denied": { deny: ["web_search"] } } } },
        sessionEntry: createSessionEntry({
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        }),
      });
      expect(mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({
        preparedWebSearchPolicy: {
          allowed: false,
          persistentAllowed: false,
          ...(known ? { modelRef: { provider: "openai", model: "native-search-denied" } } : {}),
        },
      });
    },
  );
});
