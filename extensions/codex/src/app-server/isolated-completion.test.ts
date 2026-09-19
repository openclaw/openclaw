import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuthHandoff: vi.fn(),
  runBoundedTurn: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  resolveCodexAppServerPreparedAuthHandoff: mocks.resolveAuthHandoff,
}));
vi.mock("./bounded-turn.js", () => ({
  runBoundedCodexAppServerTurn: mocks.runBoundedTurn,
}));

import { runCodexIsolatedCompletion } from "./isolated-completion.js";

type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

const authProfileStore = {
  version: 1,
  profiles: {
    "openai:test": {
      type: "oauth",
      provider: "openai",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    },
  },
};

function createParams(): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:test",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore,
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    outputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
  } as unknown as IsolatedParams;
}

function submittedInput() {
  return [{ type: "text", text: createParams().prompt, text_elements: [] }];
}

describe("runCodexIsolatedCompletion", () => {
  beforeEach(() => {
    mocks.resolveAuthHandoff.mockReset();
    mocks.runBoundedTurn.mockReset();
    mocks.resolveAuthHandoff.mockResolvedValue({
      authProfileId: "openai:test",
      nativeAuthProfile: true,
    });
    mocks.runBoundedTurn.mockResolvedValue({
      text: "Garden Planning",
      model: "gpt-5.4",
      submittedInput: submittedInput(),
      usage: { input: 7, output: 3, cacheRead: 2, total: 10 },
      items: [
        {
          id: "prompt",
          type: "userMessage",
          content: [{ type: "text", text: "Help me plan a garden." }],
        },
        { id: "reasoning", type: "reasoning" },
        { id: "answer", type: "agentMessage", text: "Garden Planning" },
      ],
    });
  });

  it("uses the selected native authorization on a private ring-zero turn", async () => {
    const params = { ...createParams(), assertCurrent: vi.fn() };

    await expect(runCodexIsolatedCompletion(params, {})).resolves.toEqual({
      assistant: expect.objectContaining({
        role: "assistant",
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Garden Planning" }],
        usage: expect.objectContaining({
          input: 7,
          output: 3,
          cacheRead: 2,
          totalTokens: 10,
        }),
      }),
    });
    expect(mocks.resolveAuthHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        authRequirement: "subscription",
        authProfileId: "openai:test",
        authProfileStore,
        agentDir: "/tmp/agent",
        homeScope: "agent",
      }),
    );
    expect(mocks.runBoundedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { mode: "required", id: "gpt-5.4" },
        profile: "openai:test",
        authRequirement: "subscription",
        isolation: "private-stdio",
        assertCurrent: params.assertCurrent,
        requireNoExternalCapabilities: true,
        developerInstructions: "Name the conversation.",
        input: [{ type: "text", text: "Help me plan a garden.", text_elements: [] }],
        outputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      }),
    );
    expect(mocks.runBoundedTurn.mock.calls[0]?.[0]).not.toHaveProperty("modelProvider");
  });

  it("forwards prepared profile auth without also selecting a profile", async () => {
    const preparedAuth = {
      kind: "profile",
      profileId: "openai:test",
      store: authProfileStore,
      snapshot: {
        loginParams: { type: "chatgptAuthTokens", accessToken: "test-access" },
        secretFreeCacheKey: "test-account",
      },
    };
    mocks.resolveAuthHandoff.mockResolvedValue({
      authProfileId: "openai:test",
      nativeAuthProfile: true,
      preparedAuth,
    });

    await runCodexIsolatedCompletion(createParams(), {});

    const boundedParams = mocks.runBoundedTurn.mock.calls[0]?.[0];
    expect(boundedParams).toMatchObject({ preparedAuth });
    expect(boundedParams).not.toHaveProperty("profile");
  });

  it("does not hand off isolated auth after its caller retires during preparation", async () => {
    const preparing = createDeferred<void>();
    const release = createDeferred<void>();
    mocks.resolveAuthHandoff.mockImplementationOnce(async () => {
      preparing.resolve();
      await release.promise;
      return { authProfileId: "openai:test", nativeAuthProfile: true };
    });
    const retired = new Error("isolated completion caller retired");
    let current = true;
    const params = {
      ...createParams(),
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    };
    const run = runCodexIsolatedCompletion(params, {});
    const rejection = expect(run).rejects.toBe(retired);
    await preparing.promise;
    current = false;
    release.resolve();

    await rejection;
    expect(mocks.runBoundedTurn).not.toHaveBeenCalled();
  });

  it("accepts a policy-directed continuation only from attested managed hooks", async () => {
    mocks.runBoundedTurn.mockResolvedValue({
      text: "Garden Planning",
      model: "gpt-5.4",
      submittedInput: submittedInput(),
      managedHooksEnabled: true,
      items: [
        {
          id: "prompt",
          type: "userMessage",
          content: [{ type: "text", text: createParams().prompt }],
        },
        { id: "draft", type: "agentMessage", text: "An earlier draft." },
        {
          id: "hook",
          type: "hookPrompt",
          fragments: [{ text: "Revise the answer.", hookRunId: "managed-stop-1" }],
        },
        { id: "answer", type: "agentMessage", text: "Garden Planning" },
      ],
    });

    await expect(runCodexIsolatedCompletion(createParams(), {})).resolves.toMatchObject({
      assistant: { content: [{ type: "text", text: "Garden Planning" }] },
    });
  });

  it.each([undefined, false])(
    "rejects hook continuations without active managed attestation (%s)",
    async (managedHooksEnabled) => {
      mocks.runBoundedTurn.mockResolvedValue({
        text: "Garden Planning",
        model: "gpt-5.4",
        submittedInput: submittedInput(),
        managedHooksEnabled,
        items: [
          {
            id: "hook",
            type: "hookPrompt",
            fragments: [{ text: "Revise the answer.", hookRunId: "hook-1" }],
          },
        ],
      });

      await expect(runCodexIsolatedCompletion(createParams(), {})).rejects.toThrow(
        "unexpected native item: hookPrompt",
      );
    },
  );

  it("rejects native tools even when managed hooks were attested", async () => {
    mocks.runBoundedTurn.mockResolvedValue({
      text: "Garden Planning",
      model: "gpt-5.4",
      submittedInput: submittedInput(),
      managedHooksEnabled: true,
      items: [{ id: "tool", type: "commandExecution" }],
    });

    await expect(runCodexIsolatedCompletion(createParams(), {})).rejects.toThrow(
      "Codex isolated completion returned unexpected native item: commandExecution",
    );
  });

  it("rejects host authorization at the native-only boundary", async () => {
    const params = createParams();
    params.authorization = {
      owner: "host",
      model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" },
      auth: { mode: "api-key", source: "test" },
    } as IsolatedParams["authorization"];

    await expect(runCodexIsolatedCompletion(params, {})).rejects.toThrow("harness-owned");
    expect(mocks.runBoundedTurn).not.toHaveBeenCalled();
  });
});
