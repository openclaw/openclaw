import "./side-question.test-support.js";
import { useProviderToolSchemaRuntimeForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, beforeAll, expect, it } from "vitest";
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

useSideQuestionTestSetup();
it.each([
  { source: "Platform alias", thinking: "off", effort: "none" },
  { source: "unknown metadata", thinking: "ultra", effort: "ultra" },
  { source: "different outer model", thinking: "off", effort: null },
] as const)("selects reasoning from $source", async ({ source, thinking, effort }) => {
  const native = effort === null;
  const model = native
    ? "gpt-5.5"
    : source === "Platform alias"
      ? "configured-alias"
      : "gpt-5.6-sol";
  const client = createFakeClient();
  getSharedCodexAppServerClientMock.mockResolvedValue(client);
  const params = sideParams({
    ...(native ? {} : { model }),
    resolvedThinkLevel: thinking,
    runtimeModel: {
      ...createCodexTestModel(),
      id: native ? "different-outer-model" : "gpt-5.6-sol",
      ...(!native && { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" }),
      compat: thinking === "ultra" ? undefined : { supportedReasoningEfforts: ["none"] },
    },
  });
  if (native) {
    readCodexAppServerBindingMock.mockReturnValue({
      threadId: "parent-thread",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model,
      modelProvider: "openai",
      preserveNativeModel: true,
    });
  } else {
    params.preparedRuntimeAuth = platformPreparedRuntimeAuth("platform-test-key");
    params.authProfileId = undefined;
    params.authProfileIdSource = undefined;
    isCodexAppServerNativeAuthProfileMock.mockReturnValue(false);
    params.preparedRuntimeAuth.plan.modelRoute!.modelId = params.model;
  }
  await expect(runCodexAppServerSideQuestion(params)).resolves.toEqual({ text: "Side answer." });
  expect(client.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({
    model,
    effort,
    ...(!native && { threadId: "side-thread" }),
    collaborationMode: { settings: { model, reasoning_effort: effort } },
  });
  if (!native) {
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
  }
});
