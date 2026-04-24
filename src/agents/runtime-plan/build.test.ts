import { describe, expect, it } from "vitest";
import { createParameterFreeTool } from "../../../test/helpers/agents/schema-normalization-runtime-contract.js";
import { buildAgentRuntimePlan } from "./build.js";

describe("AgentRuntimePlan", () => {
  it("records resolved model, auth, transport, tool, delivery, and observability policy", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai-codex",
      sessionAuthProfileId: "openai-codex:work",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
      },
    });

    expect(plan.auth).toMatchObject({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai-codex",
      harnessAuthProvider: "openai-codex",
      forwardedAuthProfileId: "openai-codex:work",
    });
    expect(plan.delivery.isSilentPayload({ text: '{"action":"NO_REPLY"}' })).toBe(true);
    expect(
      plan.delivery.isSilentPayload({
        text: '{"action":"NO_REPLY"}',
        mediaUrl: "file:///tmp/image.png",
      }),
    ).toBe(false);
    expect(plan.transport.extraParams).toMatchObject({
      parallel_tool_calls: true,
      text_verbosity: "low",
      openaiWsWarmup: false,
    });
    expect(plan.observability.resolvedRef).toBe("codex:openai/gpt-5.4");
  });

  it("keeps OpenClaw-owned tool-schema normalization reachable from the plan", () => {
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
      },
    });

    expect(plan.tools.normalize([createParameterFreeTool()] as never)[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});
