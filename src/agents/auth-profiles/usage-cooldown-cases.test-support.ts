import { vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileUsageStore as makeStore,
} from "./credential-fixtures.test-support.js";
import type { ProfileUsageStats, AuthProfileStore } from "./types.js";
import { mockLockedUpdateForStore } from "./usage-fixture.test-support.js";
import { markAuthProfileFailure } from "./usage.js";

type FailureReason = Parameters<typeof markAuthProfileFailure>[0]["reason"];

export function makeStoreWithCopilot(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  const store = makeStore(usageStats);
  store.profiles["github-copilot:github"] = createApiKeyCredential("github-copilot", "ghu_test");
  return store;
}

export async function markFailure(params: {
  store: ReturnType<typeof makeStoreWithCopilot>;
  now: number;
  reason: FailureReason;
  modelId?: string;
  useFakeTime?: boolean;
}): Promise<void> {
  if (params.useFakeTime !== false) {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
  }
  mockLockedUpdateForStore(params.store);
  try {
    await markAuthProfileFailure({
      store: params.store,
      profileId: "github-copilot:github",
      reason: params.reason,
      modelId: params.modelId,
    });
  } finally {
    if (params.useFakeTime !== false) {
      vi.useRealTimers();
    }
  }
}

export function createModelCooldownCases(now: number) {
  const activeStats = (
    reason: FailureReason,
    modelId: string,
  ): NonNullable<AuthProfileStore["usageStats"]>[string] => ({
    cooldownUntil: now + 30_000,
    cooldownReason: reason,
    cooldownModel: modelId,
    errorCount: 1,
    lastFailureAt: now - 1_000,
  });
  return [
    {
      name: "records cooldownModel on first rate_limit failure",
      initialStats: {},
      reason: "rate_limit",
      modelId: "claude-sonnet-4.6",
      expectedReason: "rate_limit",
      expectedModel: "claude-sonnet-4.6",
    },
    {
      name: "preserves cooldownModel when the same model fails again during active model_not_found cooldown",
      initialStats: activeStats("model_not_found", "claude-sonnet-4.6"),
      reason: "model_not_found",
      modelId: "claude-sonnet-4.6",
      expectedReason: "model_not_found",
      expectedModel: "claude-sonnet-4.6",
      expectedUntil: now + 30_000,
    },
    {
      name: "keeps a healthy sibling model available after a model_not_found failure on the same profile — #116464",
      initialStats: {},
      reason: "model_not_found",
      modelId: "claude-sonnet-4.6",
      expectedReason: "model_not_found",
      expectedModel: "claude-sonnet-4.6",
      availability: [
        { modelId: "claude-sonnet-4.6", expected: true },
        { modelId: "gpt-4.1", expected: false },
      ],
    },
    {
      name: "widens cooldownModel to undefined when a different model fails during active cooldown",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "rate_limit",
      modelId: "gpt-4.1",
      expectedReason: "rate_limit",
      expectedModel: undefined,
    },
    {
      name: "updates cooldownReason when auth failure occurs during active rate_limit window",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "auth",
      modelId: "claude-opus-4.6",
      expectedReason: "auth",
      expectedModel: undefined,
      useFakeTime: false,
    },
  ] satisfies Array<{
    name: string;
    initialStats: ProfileUsageStats;
    reason: FailureReason;
    modelId: string | undefined;
    expectedReason: FailureReason;
    expectedModel: string | undefined;
    expectedUntil?: number;
    availability?: Array<{ modelId: string; expected: boolean }>;
    useFakeTime?: boolean;
  }>;
}
