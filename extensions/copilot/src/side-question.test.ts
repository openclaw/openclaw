import {
  buildAgentRuntimePlan,
  type AgentHarnessSideQuestionParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import { asAttemptParams } from "../harness.test-support.js";
import {
  createCopilotIsolatedCompletionParams,
  createCopilotIsolatedHarnessFixture as isolated,
} from "./isolated-completion.test-support.js";

const ISOLATED = createCopilotIsolatedCompletionParams({ thinkLevel: "high" });
function params(): AgentHarnessSideQuestionParamsV2 {
  const authStorage = AuthStorage.inMemory();
  return {
    cfg: {},
    agentDir: ISOLATED.agentDir,
    provider: ISOLATED.provider,
    model: ISOLATED.modelId,
    question: "Compare the images",
    sessionId: "side-session",
    sessionFile: "/tmp/side-session.jsonl",
    sessionEntry: { sessionId: "side-session", updatedAt: 1 },
    resolvedReasoningLevel: "off",
    isNewSession: false,
    hostCapabilities: asAttemptParams({}).hostCapabilities,
    preparedRuntimeAuth: {
      plan: buildAgentRuntimePlan({
        config: {},
        provider: ISOLATED.provider,
        modelId: ISOLATED.modelId,
        model: ISOLATED.authorization.model,
      }).auth,
      authProfileStore: { version: 1, profiles: {} },
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
    },
  };
}

it("answers native side questions with Fusion and ordered context image attachments", async () => {
  const f = isolated({ content: "The earlier image matches.", messageId: "side-answer" });
  f.session.sendAndWait.mockImplementation(async () => {
    f.emitUsage({
      model: "fusion",
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
    });
    return {
      type: "assistant.message",
      data: { content: "The earlier image matches.", messageId: "side-answer" },
    };
  });
  const completion = {
    ...ISOLATED,
    modelId: "fusion",
    authorization: {
      ...ISOLATED.authorization,
      model: { ...ISOLATED.authorization.model, id: "fusion" },
    },
    config: {
      agents: {
        defaults: { models: { "github-copilot/fusion": { params: { fusionTier: "high" } } } },
      },
    },
  };
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  try {
    await expect(
      f.harness.runSideQuestion!({
        ...params(),
        prepareIsolatedSideQuestion: async () => ({
          kind: "completion",
          params: completion,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Earlier image" }, image],
              timestamp: 1,
            },
          ],
          images: [image],
          prepareRequest: async (request) => request,
        }),
      }),
    ).resolves.toMatchObject({
      text: "The earlier image matches.",
      usage: { input: 100, output: 12, cacheRead: 40, cacheWrite: 5, total: 157 },
    });
    expect(f.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "fusion",
        capi: { fusionTier: "high" },
        availableTools: [],
        tools: [],
      }),
    );
    expect(f.session.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Earlier image\n[Attached image: context-image-1]"),
        attachments: [
          {
            type: "blob",
            data: image.data,
            mimeType: image.mimeType,
            displayName: "context-image-1",
          },
          {
            type: "blob",
            data: image.data,
            mimeType: image.mimeType,
            displayName: "context-image-2",
          },
        ],
      }),
      expect.any(Number),
    );
    expect(f.resumeSession).not.toHaveBeenCalled();
    expect(f.session.disconnect).toHaveBeenCalledOnce();
  } finally {
    await f.harness.dispose?.();
  }
});

it.each([false, true])(
  "applies final request policy before native inference (block=%s)",
  async (block) => {
    const f = isolated({ content: "Policy-safe answer.", messageId: "policy-answer" });
    try {
      const pending = f.harness.runSideQuestion!({
        ...params(),
        prepareIsolatedSideQuestion: async () => ({
          kind: "completion",
          params: ISOLATED,
          messages: [{ role: "user", content: "private-marker", timestamp: 1 }],
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          prepareRequest: async (request) => {
            if (block) {
              throw new Error("withheld by policy");
            }
            return {
              ...request,
              prompt: request.prompt.replaceAll("private-marker", "redacted"),
              images: [],
            };
          },
        }),
      });
      if (block) {
        await expect(pending).rejects.toThrow("withheld by policy");
        expect(f.session.sendAndWait).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ text: "Policy-safe answer." });
        const request = f.session.sendAndWait.mock.calls[0]?.[0];
        expect(request).toMatchObject({ prompt: expect.stringContaining("redacted") });
        expect(JSON.stringify(request)).not.toContain("private-marker");
        expect(request).not.toHaveProperty("attachments");
      }
    } finally {
      await f.harness.dispose?.();
    }
  },
);
it.each(["empty", "tool"])("rejects a %s native side-question result", async (kind) => {
  const f = isolated({
    messageId: "side-answer",
    content: kind === "empty" ? "  " : "Partial answer",
    ...(kind === "tool"
      ? { toolRequests: [{ toolCallId: "call-1", name: "read", arguments: {} }] }
      : {}),
  });
  try {
    await expect(
      f.harness.runSideQuestion!({
        ...params(),
        prepareIsolatedSideQuestion: async () => ({
          kind: "completion",
          params: ISOLATED,
          messages: [],
          images: [],
          prepareRequest: async (request) => request,
        }),
      }),
    ).rejects.toThrow(kind === "empty" ? "no visible answer" : "tool-free answer");
    expect(f.session.disconnect).toHaveBeenCalledOnce();
  } finally {
    await f.harness.dispose?.();
  }
});
