import { afterEach, expect, it, vi } from "vitest";
import {
  recordFastModeUnsupported,
  resolveAnthropicFastModePlan,
  setLearnedFastModeUnsupported,
} from "./fast-mode-policy.js";
import { createFastModeUnsupportedModels } from "./fast-mode-unsupported.js";

function models(rows: Map<string, { learnedAt: number }>) {
  return createFastModeUnsupportedModels({
    openStore: () => ({
      entries: async () => [...rows.keys()].map((key) => ({ key })),
      register: async (key, value) => rows.set(key, value),
    }),
    warn: vi.fn(),
  });
}

const plan = (modelId: string) =>
  resolveAnthropicFastModePlan({
    provider: "anthropic",
    modelId,
    api: "anthropic-messages",
    authMode: "api_key",
    requestCapabilities: { endpointClass: "anthropic-public", allowsAnthropicServiceTier: true },
  });

afterEach(() => {
  setLearnedFastModeUnsupported({ ready: async () => {}, has: () => false, record: () => {} });
});

it("offers native fast mode to an unknown Claude model until Anthropic rejects it", async () => {
  const rows = new Map<string, { learnedAt: number }>();
  const learned = models(rows);
  await learned.ready();
  setLearnedFastModeUnsupported(learned);
  expect(plan("claude-zzz-9-9")).toBe("native");
  expect(plan("claude-fable-5-2")).toBe("native");
  expect(plan("claude-sonnet-5-5")).not.toBe("native");

  recordFastModeUnsupported("claude-zzz-9-9");
  expect(plan("claude-zzz-9-9")).not.toBe("native");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  // A restarted process loads the stored answer.
  const restarted = models(rows);
  await restarted.ready();
  setLearnedFastModeUnsupported(restarted);
  expect(plan("claude-zzz-9-9")).not.toBe("native");
  expect(plan("claude-fable-5-2")).toBe("native");
});

it("keeps the static answer when plugin state is unavailable", async () => {
  const learned = createFastModeUnsupportedModels({
    openStore: () => {
      throw new Error("state closed");
    },
    warn: vi.fn(),
  });
  await learned.ready();
  setLearnedFastModeUnsupported(learned);
  expect(plan("claude-opus-5-5")).toBe("native");
  learned.record("claude-opus-5-5");
  expect(plan("claude-opus-5-5")).not.toBe("native");
});
