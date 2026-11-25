import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveAuthHandoff: vi.fn(), runBoundedTurn: vi.fn() }));

vi.mock("./auth-bridge.js", () => ({
  resolveCodexAppServerPreparedAuthHandoff: mocks.resolveAuthHandoff,
}));
// mock-isolation: Exercise completion orchestration without starting a native provider turn.
vi.mock("./bounded-turn.js", () => ({ runBoundedCodexAppServerTurn: mocks.runBoundedTurn }));

import { runCodexIsolatedCompletion } from "./isolated-completion.js";
import { isolatedParams, type IsolatedParams } from "./isolated-completion.params-test-support.js";

const authProfileStore: AuthProfileStore = { version: 1, profiles: {} };
const outputSchema = { type: "object" };
const createParams = () => ({ ...isolatedParams(authProfileStore, "openai:test"), outputSchema });
const authHandoff = { authProfileId: "openai:test", nativeAuthProfile: true };
const expectCall = (mock: ReturnType<typeof vi.fn>, params: Record<string, unknown>) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(params));

const answer = { id: "answer", type: "agentMessage", text: "Garden Planning" };
const prompt = {
  id: "prompt",
  type: "userMessage",
  content: [{ type: "text", text: "Help me plan a garden." }],
};
const hook = (hookRunId: string) => ({
  id: "hook",
  type: "hookPrompt",
  fragments: [{ text: "Revise the answer.", hookRunId }],
});
function turn(items: unknown[], managedHooksEnabled?: boolean) {
  mocks.runBoundedTurn.mockResolvedValue({
    text: "Garden Planning",
    model: "gpt-5.4",
    submittedInput: [{ type: "text", text: createParams().prompt, text_elements: [] }],
    usage: { input: 7, output: 3, cacheRead: 2, total: 10 },
    items,
    managedHooksEnabled,
  });
}
const run = (params = createParams()) => runCodexIsolatedCompletion(params, {});

describe("runCodexIsolatedCompletion", () => {
  beforeEach(() => {
    mocks.resolveAuthHandoff.mockReset().mockResolvedValue(authHandoff);
    mocks.runBoundedTurn.mockReset();
    turn([prompt, { id: "reasoning", type: "reasoning" }, answer]);
  });

  it.each([false, true])("uses private ring-zero auth with managed hooks=%s", async (managed) => {
    turn(
      [
        prompt,
        { id: "reasoning", type: "reasoning" },
        ...(managed
          ? [
              { id: "draft", type: "agentMessage", text: "An earlier draft." },
              hook("managed-stop-1"),
            ]
          : []),
        answer,
      ],
      managed,
    );
    const params = { ...createParams(), assertCurrent: vi.fn() };

    await expect(run(params)).resolves.toEqual({
      assistant: expect.objectContaining({
        role: "assistant",
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Garden Planning" }],
        usage: expect.objectContaining({ input: 7, output: 3, cacheRead: 2, totalTokens: 10 }),
      }),
    });
    expectCall(mocks.resolveAuthHandoff, {
      authRequirement: "subscription",
      authProfileId: "openai:test",
      authProfileStore,
      agentDir: "/tmp/agent",
      homeScope: "agent",
    });
    expectCall(mocks.runBoundedTurn, {
      model: { mode: "required", id: "gpt-5.4" },
      profile: "openai:test",
      authRequirement: "subscription",
      isolation: "private-stdio",
      assertCurrent: params.assertCurrent,
      requireNoExternalCapabilities: true,
      developerInstructions: "Name the conversation.",
      input: [{ type: "text", text: "Help me plan a garden.", text_elements: [] }],
      outputSchema,
    });
    expectCall(mocks.runBoundedTurn, {
      modelProvider: "openai",
      threadConfig: { openai_base_url: "https://chatgpt.com/backend-api/codex" },
    });
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
    mocks.resolveAuthHandoff.mockResolvedValue({ ...authHandoff, preparedAuth });

    await run();

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
      return authHandoff;
    });
    const retired = new Error("isolated completion caller retired");
    const assertCurrent = vi.fn<() => void>();
    const rejection = expect(run({ ...createParams(), assertCurrent })).rejects.toBe(retired);
    await preparing.promise;
    assertCurrent.mockImplementation(() => {
      throw retired;
    });
    release.resolve();

    await rejection;
    expect(mocks.runBoundedTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["hookPrompt", undefined],
    ["commandExecution", true],
  ] as const)("rejects native %s with managed attestation %s", async (type, attested) => {
    turn([type === "hookPrompt" ? hook("hook-1") : { id: "tool", type }], attested);
    await expect(run()).rejects.toThrow(
      `Codex isolated completion returned unexpected native item: ${type}`,
    );
  });

  it("rejects incomplete host authorization before native dispatch", async () => {
    const params = createParams();
    params.authorization = {
      owner: "host",
      model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" },
      auth: { mode: "api-key", source: "test" },
    } as IsolatedParams["authorization"];

    await expect(run(params)).rejects.toThrow("prepared Responses API-key");
    expect(mocks.runBoundedTurn).not.toHaveBeenCalled();
  });
  it("preserves a host API key, exact model and endpoint on native dispatch", async () => {
    const params = createParams();
    params.authorization = {
      owner: "host",
      model: {
        provider: "openai",
        id: "selected-model",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      auth: {
        mode: "api-key",
        apiKey: "synthetic-selected-key",
        source: "profile:openai:selected",
        profileId: "openai:selected",
      },
    } as IsolatedParams["authorization"];
    await expect(run(params)).resolves.toMatchObject({
      assistant: { api: "openai-responses", provider: "openai" },
    });
    expect(mocks.resolveAuthHandoff).not.toHaveBeenCalled();
    expectCall(mocks.runBoundedTurn, {
      model: { mode: "required", id: "selected-model" },
      modelProvider: "openai",
      preparedAuth: { kind: "api-key", apiKey: "synthetic-selected-key" },
      threadConfig: { openai_base_url: "https://api.openai.com/v1" },
      requireInferenceRoute: true,
      requireNoExternalCapabilities: true,
      isolation: "private-stdio",
    });
  });

  it("keeps SIWC OAuth on the selected public endpoint with its profile refresh owner", async () => {
    const params = createParams();
    if (params.authorization.owner !== "harness") {
      throw new Error("fixture");
    }
    params.authorization.plan.modelRoute!.authRequirement = "api-key";
    params.authorization.plan.modelRoute!.api = "openai-responses";
    params.authorization.plan.modelRoute!.baseUrl = "https://api.openai.com/v1";
    params.authorization.plan.selectedAuthMode = "oauth";
    params.authorization.plan.selectedAuthFlow = "chatgpt-token-sharing";
    const preparedAuth = {
      kind: "profile",
      profileId: "openai:test",
      store: authProfileStore,
      snapshot: {
        inferenceAuth: "host-oauth",
        loginParams: { type: "apiKey", apiKey: "synthetic-placeholder" },
        secretFreeCacheKey: "account",
      },
    };
    mocks.resolveAuthHandoff.mockResolvedValue({ preparedAuth });
    await expect(run(params)).resolves.toMatchObject({ assistant: { api: "openai-responses" } });
    expectCall(mocks.runBoundedTurn, {
      preparedAuth,
      requireInferenceRoute: true,
      threadConfig: { openai_base_url: "https://api.openai.com/v1" },
    });
  });
});
