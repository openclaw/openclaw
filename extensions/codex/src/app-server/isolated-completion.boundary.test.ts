import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { codexModel, createClientFactory } from "./bounded-turn.test-harness.js";

vi.mock("./auth-bridge.js", () => ({
  resolveCodexAppServerPreparedAuthHandoff: vi.fn(async () => ({ nativeAuthProfile: true })),
}));

import { runCodexIsolatedCompletion } from "./isolated-completion.js";

type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

function createParams(overrides: Partial<IsolatedParams> = {}): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
      authProfileStore: { version: 1, profiles: {} },
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("Codex isolated completion native boundary", () => {
  it.each([
    { thinkLevel: undefined, supported: ["low", "high"], expected: "low" },
    { thinkLevel: "high", supported: ["low", "high"], expected: "high" },
    { thinkLevel: "max", supported: ["medium", "xhigh"], expected: "xhigh" },
    { thinkLevel: "off", supported: ["none", "low"], expected: "none" },
  ] as const)(
    "maps requested reasoning $thinkLevel to native effort $expected",
    async ({ thinkLevel, supported, expected }) => {
      const fake = createClientFactory({
        models: [
          {
            ...codexModel(),
            supportedReasoningEfforts: supported.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
          },
        ],
      });

      await runCodexIsolatedCompletion(createParams({ thinkLevel }), {
        clientFactory: fake.factory,
      });

      const turn = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
      expect(turn).toMatchObject({ effort: expected });
    },
  );

  it.each([undefined, "strict-visible"] as const)(
    "applies output policy %s to a successful native turn without an answer",
    async (outputTextPolicy) => {
      const fake = createClientFactory({ emptyAnswer: true });
      const completion = runCodexIsolatedCompletion(createParams({ outputTextPolicy }), {
        clientFactory: fake.factory,
      });

      if (outputTextPolicy === "strict-visible") {
        await expect(completion).resolves.toMatchObject({
          assistant: {
            stopReason: "stop",
            content: [{ type: "text", text: "" }],
          },
        });
      } else {
        await expect(completion).rejects.toThrow("isolated completion turn returned no text");
      }
    },
  );
});
