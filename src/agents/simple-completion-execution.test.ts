import { readFileSync } from "node:fs";
import path from "node:path";
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-events.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { bindModelCompletionOwner } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { completionContext, completionModel } from "./simple-completion.test-support.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

it.each(["success", "returned-error", "thrown"])(
  "records a timeline-only %s completion without diagnostic listeners",
  async (outcome) => {
    const file = path.join(tempDirs.make("simple-completion-timeline-"), "timeline.jsonl");
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    const message = makeAssistantMessageFixture({
      stopReason: outcome === "success" ? "stop" : "error",
      errorMessage: outcome === "success" ? undefined : "fixture error",
    });
    message.usage.usageReport = { state: "available" };
    if (outcome === "thrown") mocks.complete.mockRejectedValueOnce(new Error("before usage"));
    else mocks.complete.mockResolvedValueOnce(message);
    await withEnvAsync(
      {
        OPENCLAW_DIAGNOSTICS: "timeline",
        OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: file,
      },
      async () => {
        const result = complete({ model: baseModel });
        if (outcome === "thrown") await expect(result).rejects.toThrow("before usage");
        else await expect(result).resolves.toBe(message);
        flushDiagnosticsTimeline();
      },
    );
    const events = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.name === "provider.request.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "provider.request")).toEqual([
      expect.objectContaining({
        ok: outcome === "success",
        attributes: expect.objectContaining({
          observationUnit: "logical-call",
          usageState: outcome === "thrown" ? "unreported" : "available",
          ...(outcome === "thrown" ? {} : { input: 0, output: 0 }),
        }),
      }),
    ]);
  },
);

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

it("passes non-secret auth facts to preparation and executes its returned transport", async () => {
  const selectedAuth: CompletionParams["auth"] = {
    apiKey: "test-access-token",
    source: "profile:test",
    profileId: "test:profile",
    mode: "oauth",
    authFlow: "test-subscription",
  };
  const cfg = { plugins: { enabled: false } };
  const preparedModel = { ...baseModel, api: "openclaw-provider-simple:test" };
  mocks.prepareModel.mockReturnValueOnce(preparedModel);
  await complete({ model: baseModel, auth: selectedAuth, cfg });
  expect(mocks.prepareModel.mock.calls[0]?.[0]).toStrictEqual({
    apiRegistry: expect.anything(),
    model: baseModel,
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
])("preserves routing options for $name", async ({ options, expectedHeaders }) => {
  const original = structuredClone(options);
  await complete({ model: { ...baseModel, ...opencode }, options });
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
