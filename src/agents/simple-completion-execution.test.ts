import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { beforeEach, expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { bindModelCompletionOwner } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import {
  completionConfig,
  completionContext,
  completionModel,
} from "./simple-completion.test-support.js";

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
type Options = NonNullable<CompletionParams["options"]>;
type ReasoningCase = [Options["reasoning"], string | undefined, Partial<Model>?, string?];
const context = completionContext("pong");
const auth = { apiKey: "test-key", source: "test", mode: "api-key" } as const;
const baseModel = completionModel({
  provider: "openai",
  id: "gpt-5.4",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
});
const opencode = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
const custom = { provider: "custom", id: "synthetic-model" };
const sonnet: Partial<Model> = {
  provider: "anthropic",
  id: "production-sonnet",
  api: "anthropic-messages",
  params: { canonicalModelId: "claude-sonnet-5" },
};

function complete(
  params: Omit<CompletionParams, "context" | "auth"> & { auth?: CompletionParams["auth"] },
) {
  return completeWithPreparedSimpleCompletionModel({ context, auth, ...params });
}

const completionOptions = () => mocks.complete.mock.calls.map((call) => call[2]);
function expectCompletion(model: Model, options: unknown) {
  expect(mocks.complete.mock.calls.map((call) => call.slice(0, 3))).toEqual([
    [model, context, options],
  ]);
}

beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.prepareModel.mockReset().mockImplementation((params) => params.model);
});

it.each([
  "src/agents/host-prepared-isolated-completion.ts",
  "src/plugin-sdk/simple-completion-runtime.ts",
])("%s does not import model/auth preparation", (entry) => {
  expect(findSourceImportBackedges(entry, ["src/agents/simple-completion-runtime.ts"])).toEqual([]);
});

it.each<ReasoningCase>([
  ["ultra", "high", custom],
  ["ultra", "off", { ...custom, reasoning: false }],
  ["ultra", undefined, { compat: { supportsReasoningEffort: false } }],
  ["max", "max"],
  ["off", "off"],
  ["ultra", "xhigh"],
  ["adaptive", "medium"],
  [undefined, undefined],
  ["off", "off", sonnet, "openclaw-provider-simple:anthropic:production-sonnet"],
])(
  "preserves transport reasoning %s as %s for %j",
  async (reasoning, expected, patch, preparedApi) => {
    const model: Model = { ...baseModel, ...patch };
    const preparedModel = preparedApi ? { ...model, api: preparedApi } : model;
    mocks.prepareModel.mockReturnValueOnce(preparedModel);
    await complete({ model, options: { reasoning } });
    if (expected === undefined) {
      expect(completionOptions()[0]).not.toHaveProperty("reasoning");
    }
    expectCompletion(preparedModel, {
      ...(expected ? { reasoning: expected } : {}),
      ...(reasoning === "off" ? { onPayload: expect.any(Function) } : {}),
      apiKey: auth.apiKey,
    });
  },
);

it.each<{
  name: string;
  model: Model;
  auth: CompletionParams["auth"];
  cfg?: CompletionParams["cfg"];
  preparedApi?: string;
}>([
  {
    name: "OAuth facts without credentials",
    model: baseModel,
    auth: {
      apiKey: "test-access-token",
      source: "profile:test",
      profileId: "test:profile",
      mode: "oauth",
      authFlow: "test-subscription",
    },
  },
  {
    name: "provider-owned stream API",
    model: completionModel({ id: "llama3.2:latest" }),
    auth: { apiKey: "ollama-local", source: "models.json (local marker)", mode: "api-key" },
    cfg: completionConfig("ollama", { baseUrl: "http://remote-ollama:11434", models: [] }),
    preparedApi: "openclaw-ollama-simple-test",
  },
])("prepares $name", async ({ model, auth: selectedAuth, cfg, preparedApi }) => {
  const preparedModel = preparedApi ? { ...model, api: preparedApi } : model;
  mocks.prepareModel.mockReturnValueOnce(preparedModel);
  await complete({ model, auth: selectedAuth, cfg });
  expect(mocks.prepareModel).toHaveBeenCalledOnce();
  expect(mocks.prepareModel.mock.calls[0]?.[0]).toStrictEqual({
    apiRegistry: expect.anything(),
    model,
    cfg,
    auth: { mode: selectedAuth.mode, authFlow: selectedAuth.authFlow },
  });
  expectCompletion(preparedModel, { apiKey: selectedAuth.apiKey });
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
    await complete({ model: { ...baseModel, ...opencode } });
  }
  const [first, second] = completionOptions();
  const firstId = first?.headers?.["x-opencode-session"];
  const secondId = second?.headers?.["x-opencode-session"];
  expect(firstId).toEqual(expect.stringMatching(/[\s\S]+/));
  expect(secondId).toEqual(expect.any(String));
  expect(secondId).not.toBe(firstId);
  expect(first?.sessionId).toBeUndefined();
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
    ...opencode,
    ...patch,
  };
  const originalModelHeaders = structuredClone(model.headers);
  for (let index = 0; index < 2; index++) {
    await complete({ model, options });
  }
  expect(completionOptions().map((requestOptions) => requestOptions.headers)).toEqual([
    expectedHeaders,
    expectedHeaders,
  ]);
  expect(mocks.complete.mock.calls[0]?.[0].headers).toEqual(originalModelHeaders);
  expect(completionOptions()[0]).toEqual({
    ...options,
    apiKey: auth.apiKey,
    ...(expectedHeaders ? { headers: expectedHeaders } : {}),
  });
  expect(options).toEqual(original);
});

it("carries strict visibility internally without adding a wire option", async () => {
  await complete({ model: baseModel, options: { strictReasoningTags: true } });
  const options = mocks.complete.mock.calls[0]?.[2] as object | undefined;
  expect(reasoningTagTextPolicy.isStrict(options)).toBe(true);
  expect(Object.keys(options ?? {})).toEqual(["apiKey"]);
});
