import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { bindModelCompletionOwner } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  prepareModel: vi.fn((params: { model: unknown }) => params.model),
}));

vi.mock("../llm/stream.js", () => ({ completeSimple: mocks.complete }));
vi.mock("./ai-transport-runtime-host.js", () => ({}));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  prepareModelForSimpleCompletion: mocks.prepareModel,
}));

import { completeWithPreparedSimpleCompletionModel } from "./simple-completion-execution.js";

type CompletionParams = Parameters<typeof completeWithPreparedSimpleCompletionModel>[0];
const context = { messages: [{ role: "user" as const, content: "pong", timestamp: 1 }] };
const auth = { apiKey: "test-key", source: "test", mode: "api-key" } as const;
const baseModel = {
  provider: "openai",
  id: "gpt-5.4",
  name: "gpt-5.4",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} satisfies Model<"openai-responses">;

function complete(
  params: Omit<CompletionParams, "context" | "auth"> & { auth?: CompletionParams["auth"] },
) {
  return completeWithPreparedSimpleCompletionModel({ context, auth, ...params });
}

function completionRequests() {
  return mocks.complete.mock.calls.map(([model, completionContext, options]) => ({
    model,
    context: completionContext,
    options,
  }));
}

beforeEach(() => {
  mocks.complete.mockReset();
  mocks.complete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.prepareModel.mockReset();
  mocks.prepareModel.mockImplementation((params: { model: unknown }) => params.model);
});

describe("prepared completion import boundary", () => {
  it.each([
    "src/agents/host-prepared-isolated-completion.ts",
    "src/plugin-sdk/simple-completion-runtime.ts",
  ])("%s does not import model/auth preparation", (entry) => {
    expect(findSourceImportBackedges(entry, ["src/agents/simple-completion-runtime.ts"])).toEqual(
      [],
    );
  });
});

describe("completeWithPreparedSimpleCompletionModel", () => {
  it.each<{
    name: string;
    patch?: Partial<Model>;
    reasoning: NonNullable<CompletionParams["options"]>["reasoning"];
    expected?: string;
    preparedApi?: string;
  }>([
    {
      name: "custom Ultra",
      patch: { provider: "custom", id: "synthetic-model" },
      reasoning: "ultra",
      expected: "high",
    },
    {
      name: "non-reasoning Ultra",
      patch: { provider: "custom", id: "synthetic-model", reasoning: false },
      reasoning: "ultra",
      expected: "off",
    },
    {
      name: "disabled native effort",
      patch: { compat: { supportsReasoningEffort: false } },
      reasoning: "ultra",
    },
    { name: "explicit max", reasoning: "max", expected: "max" },
    { name: "explicit off", reasoning: "off", expected: "off" },
    { name: "native Ultra", reasoning: "ultra", expected: "xhigh" },
    { name: "adaptive", reasoning: "adaptive", expected: "medium" },
    { name: "unspecified", reasoning: undefined },
    {
      name: "prepared Sonnet alias",
      patch: {
        provider: "anthropic",
        id: "production-sonnet",
        name: "Production Sonnet",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        params: { canonicalModelId: "claude-sonnet-5" },
      },
      reasoning: "off",
      expected: "off",
      preparedApi: "openclaw-provider-simple:anthropic:production-sonnet",
    },
  ])(
    "preserves transport reasoning for $name",
    async ({ patch, reasoning, expected, preparedApi }) => {
      const model: Model = { ...baseModel, ...patch };
      const preparedModel = preparedApi ? { ...model, api: preparedApi } : model;
      mocks.prepareModel.mockReturnValueOnce(preparedModel);
      await complete({ model, options: { reasoning } });
      if (expected === undefined) {
        expect(completionRequests()[0]?.options).not.toHaveProperty("reasoning");
      }
      expect(completionRequests()).toEqual([
        {
          model: preparedModel,
          context,
          options: { ...(expected ? { reasoning: expected } : {}), apiKey: auth.apiKey },
        },
      ]);
    },
  );

  it("passes only selected auth facts to transport preparation", async () => {
    await complete({
      model: baseModel,
      auth: {
        apiKey: "test-access-token",
        source: "profile:test",
        profileId: "test:profile",
        mode: "oauth",
        authFlow: "test-subscription",
      },
    });
    expect(mocks.prepareModel.mock.calls[0]?.[0]).toMatchObject({
      auth: { mode: "oauth", authFlow: "test-subscription" },
    });
    expect(mocks.prepareModel.mock.calls[0]?.[0]).not.toHaveProperty("auth.apiKey");
    expect(completionRequests()[0]?.options.apiKey).toBe("test-access-token");
  });

  it("stops before transport preparation when its owner retires during host initialization", async () => {
    const retired = new Error("Completion owner retired.");
    let current = true;
    const model = bindModelCompletionOwner(baseModel, {
      run: (run) => run(),
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const completion = complete({ model });
    current = false;
    await expect(completion).rejects.toBe(retired);
    expect(mocks.prepareModel).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("gives standalone OpenCode completions distinct routing identities", async () => {
    for (let index = 0; index < 2; index++) {
      await complete({
        model: { ...baseModel, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
      });
    }
    const [first, second] = completionRequests();
    const firstId = first?.options.headers?.["x-opencode-session"];
    const secondId = second?.options.headers?.["x-opencode-session"];
    expect(firstId).toEqual(expect.any(String));
    expect(firstId.length).toBeGreaterThan(0);
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);
    expect(first?.options.sessionId).toBeUndefined();
  });

  it.each<{
    name: string;
    patch?: Partial<Model>;
    options?: CompletionParams["options"];
    expectedHeaders?: Record<string, string>;
  }>([
    {
      name: "caller header",
      options: { headers: { "X-OpenCode-Session": "caller-owned", "X-Custom": "keep" } },
      expectedHeaders: { "X-OpenCode-Session": "caller-owned", "X-Custom": "keep" },
    },
    {
      name: "caller session",
      options: { sessionId: "conversation-a", headers: { "X-Custom": "keep" } },
      expectedHeaders: { "x-opencode-session": "conversation-a", "X-Custom": "keep" },
    },
    { name: "model header", patch: { headers: { "X-OpenCode-Session": "caller-owned" } } },
    { name: "proxy endpoint", patch: { baseUrl: "https://proxy.example/v1" } },
    { name: "insecure endpoint", patch: { baseUrl: "http://opencode.ai/zen/go/v1" } },
  ])("preserves routing options for $name", async ({ patch, options, expectedHeaders }) => {
    const original = structuredClone(options);
    const model: Model = {
      ...baseModel,
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      ...patch,
    };
    const originalModelHeaders = structuredClone(model.headers);
    for (let index = 0; index < 2; index++) {
      await complete({ model, options });
    }
    expect(completionRequests().map((request) => request.options.headers)).toEqual([
      expectedHeaders,
      expectedHeaders,
    ]);
    expect(completionRequests()[0]?.model.headers).toEqual(originalModelHeaders);
    expect(completionRequests()[0]?.options).toEqual({
      ...options,
      apiKey: auth.apiKey,
      ...(expectedHeaders ? { headers: expectedHeaders } : {}),
    });
    expect(options).toEqual(original);
  });

  it("prepares provider-owned stream APIs before running a completion", async () => {
    const model = {
      ...baseModel,
      provider: "ollama",
      id: "llama3.2:latest",
      name: "llama3.2:latest",
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"ollama">;
    const preparedModel = { ...model, api: "openclaw-ollama-simple-test" };
    const cfg = {
      models: { providers: { ollama: { baseUrl: "http://remote-ollama:11434", models: [] } } },
    };
    mocks.prepareModel.mockReturnValueOnce(preparedModel);
    await complete({
      model,
      auth: { apiKey: "ollama-local", source: "models.json (local marker)", mode: "api-key" },
      cfg,
    });
    expect(mocks.prepareModel).toHaveBeenCalledWith({
      apiRegistry: expect.anything(),
      model,
      cfg,
      auth: { mode: "api-key", authFlow: undefined },
    });
    expect(completionRequests()).toEqual([
      { model: preparedModel, context, options: { apiKey: "ollama-local" } },
    ]);
  });

  it("carries strict visibility internally without adding a wire option", async () => {
    await complete({ model: baseModel, options: { strictReasoningTags: true } });
    const options = mocks.complete.mock.calls[0]?.[2] as object | undefined;
    expect(reasoningTagTextPolicy.isStrict(options)).toBe(true);
    expect(Object.keys(options ?? {})).toEqual(["apiKey"]);
  });
});
