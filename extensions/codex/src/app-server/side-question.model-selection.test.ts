import "./side-question.test-support.js";
import { useProviderToolSchemaRuntimeForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexTestModel } from "./test-support.js";

const {
  createFakeClient,
  createOpenClawCodingToolsMock,
  getSharedCodexAppServerClientMock,
  isCodexAppServerNativeAuthProfileMock,
  platformPreparedRuntimeAuth,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

beforeAll(() => setRuntimeConfigSnapshot({}));
afterAll(() => clearRuntimeConfigSnapshot());
useProviderToolSchemaRuntimeForTest(["openai", "codex", "lmstudio"]);

describe("side-question model selection", () => {
  useSideQuestionTestSetup();

  it.each([
    {
      metadata: "Platform",
      thinking: "off",
      rawModel: "configured-alias",
      supported: ["none", "low", "medium", "high", "xhigh", "max"],
      expected: "none",
    },
    { metadata: "unknown", thinking: "ultra", supported: undefined, expected: "ultra" },
  ] as const)(
    "sends $thinking with $metadata metadata to the side-question request boundary",
    async (scenario) => {
      const { thinking, supported, expected } = scenario;
      const requestedModel = "rawModel" in scenario ? scenario.rawModel : "gpt-5.6-sol";
      const client = createFakeClient();
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      const compat: ModelCompatConfig | undefined = supported
        ? { supportedReasoningEfforts: [...supported] }
        : undefined;
      const params = sideParams({
        model: requestedModel,
        resolvedThinkLevel: thinking,
        runtimeModel: {
          ...createCodexTestModel(),
          id: "gpt-5.6-sol",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          compat,
        },
      });
      params.preparedRuntimeAuth = platformPreparedRuntimeAuth("platform-test-key");
      params.authProfileId = undefined;
      params.authProfileIdSource = undefined;
      isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
      params.preparedRuntimeAuth.plan.modelRoute!.modelId = params.model;

      await expect(runCodexAppServerSideQuestion(params)).resolves.toEqual({
        text: "Side answer.",
      });

      expect(getSharedCodexAppServerClientMock).toHaveBeenCalledWith(
        expect.objectContaining({ preparedAuth: { kind: "api-key", apiKey: "platform-test-key" } }),
      );
      expect(getSharedCodexAppServerClientMock.mock.calls[0]?.[0]).not.toHaveProperty(
        "authProfileId",
      );
      expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterThinkingLevel: thinking,
          requesterModel: { provider: "openai", model: "gpt-5.6-sol" },
        }),
      );
      const turnStartCall = client.request.mock.calls.find(([method]) => method === "turn/start");
      expect(turnStartCall?.[1]).toMatchObject({
        threadId: "side-thread",
        model: requestedModel,
        effort: expected,
        collaborationMode: {
          settings: { model: requestedModel, reasoning_effort: expected },
        },
      });
    },
  );

  it("does not borrow reasoning capabilities from a different outer model", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue({
      threadId: "parent-thread",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
    });
    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          resolvedThinkLevel: "off",
          runtimeModel: {
            ...createCodexTestModel(),
            id: "different-outer-model",
            compat: { supportedReasoningEfforts: ["none"] },
          },
        }),
      ),
    ).resolves.toEqual({ text: "Side answer." });
    const turn = client.request.mock.calls.find(([method]) => method === "turn/start");
    expect(turn?.[1]).toMatchObject({
      model: "gpt-5.5",
      effort: null,
      collaborationMode: { settings: { model: "gpt-5.5", reasoning_effort: null } },
    });
  });
});
