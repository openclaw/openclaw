import { stableStringify } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import {
  captureOpenAIResponsesOutput,
  normalizeOpenAIResponsesPrefixInput,
} from "./embedded-agent-runner.wire.test-support.js";

// Compare inherited response.completed output with independent cold-replay fixtures.
// The admitted-runner proof covers persistence; this guards the release proof itself.
const reasoning = {
  type: "reasoning",
  summary: [],
  encrypted_content: "opaque-synthetic-ciphertext",
};
const call = {
  type: "function_call",
  call_id: "call_synthetic",
  name: "cache_probe",
  arguments: '{ "n": 9007199254740993 }',
};
const snapshot = (input: unknown[]) =>
  snapshotProviderPrefix(
    "openai-responses",
    JSON.parse(stableStringify({ input: normalizeOpenAIResponsesPrefixInput(input) })),
  );

it("compares inherited encrypted reasoning with ID-free cold replay", () => {
  const inherited = captureOpenAIResponsesOutput([{ ...reasoning, id: "rs_synthetic" }]);
  assertStableProviderPrefix(snapshot(inherited), snapshot([reasoning]), {
    label: "reasoning reopen",
  });
  expect(inherited).toEqual([{ ...reasoning, id: "rs_synthetic" }]);
});

it("preserves original function argument bytes in inherited completed output", () => {
  const inherited = captureOpenAIResponsesOutput([
    { ...call, id: "fc_synthetic", status: "completed" },
  ]);
  assertStableProviderPrefix(snapshot(inherited), snapshot([call]), { label: "arguments reopen" });
  expect(inherited).toEqual([{ ...call, id: "fc_synthetic" }]);
});

it.each([
  ["ciphertext", { ...reasoning, encrypted_content: "changed" }, call],
  ["summary", { ...reasoning, summary: [{ type: "summary_text", text: "changed" }] }, call],
  ["arguments", reasoning, { ...call, arguments: '{"n":9007199254740993}' }],
  ["call ID", reasoning, { ...call, call_id: "call_changed" }],
  ["tool name", reasoning, { ...call, name: "changed" }],
])("still rejects changed %s", (_name, nextReasoning, nextCall) => {
  expect(() =>
    assertStableProviderPrefix(snapshot([reasoning, call]), snapshot([nextReasoning, nextCall]), {
      label: "strict content",
    }),
  ).toThrow("prefix changed");
});
