import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

// Mock the model-fallback module BEFORE importing compact.ts so the import
// resolves to our captured mock. We only need to assert the call shape — the
// inner `run` callback never has to execute, because we resolve a fake result.
vi.mock("../model-fallback.js", () => ({
  runWithModelFallback: vi.fn(async (params: Record<string, unknown>) => ({
    result: { ok: true, compacted: false, reason: "no-op" },
    provider: params.provider,
    model: params.model,
    attempts: [],
  })),
  isFallbackSummaryError: () => false,
}));

// Stub the inner once-fn dependencies. compactEmbeddedAgentSessionDirectOnce isn't
// reached in this test (runWithModelFallback is mocked to short-circuit), so we
// don't need to wire its runtime — but the module-level imports still resolve.
vi.mock("./compact.queued.js", () => ({ compactEmbeddedAgentSession: vi.fn() }));

import { runWithModelFallback } from "../model-fallback.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";

const runMock = vi.mocked(runWithModelFallback);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "agent:main:test-session",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp",
};

function configWithFallbacks(fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks,
        },
      },
    },
  } as OpenClawConfig;
}

describe("compactEmbeddedAgentSessionDirect — abortSignal threading (regression for openclaw/openclaw#62682)", () => {
  beforeEach(() => {
    runMock.mockClear();
  });

  it("forwards params.abortSignal to runWithModelFallback so terminal aborts during compaction short-circuit", async () => {
    // Flagged by @Lellansin reviewing #62682: the compaction model-fallback
    // call must receive the caller's abort signal, otherwise a terminal abort
    // mid-compaction is classified as a failed compaction candidate and
    // cascades into the next compaction fallback model — exactly the kind of
    // wasted retry this PR is supposed to stop.
    const controller = new AbortController();

    await compactEmbeddedAgentSessionDirect({
      ...baseParams,
      config: configWithFallbacks(["anthropic/claude-haiku-4-5", "openai/gpt-4.1-mini"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      abortSignal: controller.signal,
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedParams = runMock.mock.calls[0]?.[0];
    expect(passedParams?.abortSignal).toBe(controller.signal);
  });

  it("passes undefined when no abortSignal is set (back-compat)", async () => {
    await compactEmbeddedAgentSessionDirect({
      ...baseParams,
      config: configWithFallbacks(["anthropic/claude-haiku-4-5"]),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(runMock).toHaveBeenCalledTimes(1);
    const passedParams = runMock.mock.calls[0]?.[0];
    expect(passedParams?.abortSignal).toBeUndefined();
  });
});
