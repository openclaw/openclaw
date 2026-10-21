import { beforeEach, describe, expect, it } from "vitest";
import * as btw from "./btw.test-support.js";

const modelRef = { provider: "openai", model: "gpt-5.5" } as const;
const model = { provider: modelRef.provider, id: modelRef.model, api: "openai-responses" } as const;

describe("BTW prepared tool policy", () => {
  btw.setupBtwTestHooks();
  beforeEach(() => {
    btw.mockOpenAIPlatformProfile();
    const resolvedModel = { ...model, baseUrl: "https://api.openai.com/v1" };
    btw.resolveModelWithRegistryMock.mockReturnValue(resolvedModel);
    btw.resolveModelAsyncMock.mockResolvedValue({ model: resolvedModel });
  });

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness();
    btw.resolveModelWithRegistryMock.mockReturnValue(model);
    await btw.runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": { toolsBySender: { "id:restricted-sender": { deny: ["*"] } } },
            },
          },
        },
      } as never,
      ...modelRef,
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(btw.mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({
      toolsAllow: [],
      preparedWebSearchPolicy: {
        allowed: false,
        persistentAllowed: true,
        modelRef,
      },
    });
  });

  it.each([true, false])(
    "prepares search for native side-question ownership with a known model: %s",
    async (known) => {
      const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
        resolveSessionRuntimeOwnershipAsync: async () => ({
          model: "native",
          auth: "native",
          ...(known ? { modelRef: { provider: "openai", model: "native-search-denied" } } : {}),
        }),
      });
      await btw.runSideQuestion({
        ...modelRef,
        cfg: { tools: { byProvider: { "openai/native-search-denied": { deny: ["web_search"] } } } },
        sessionEntry: btw.createSessionEntry({
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        }),
      });
      expect(btw.mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({
        preparedWebSearchPolicy: {
          allowed: false,
          persistentAllowed: false,
          ...(known ? { modelRef: { provider: "openai", model: "native-search-denied" } } : {}),
        },
      });
    },
  );
});
