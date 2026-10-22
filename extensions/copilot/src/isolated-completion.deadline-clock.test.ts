import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { runCopilotIsolatedCompletion } from "./isolated-completion.js";
import type { CopilotClientPool } from "./runtime.js";

type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletionV2"]>
>[0];

const ISOLATED_COMPLETION_PARAMS = {
  provider: "github-copilot",
  modelId: "gpt-4.1",
  authorization: {
    owner: "host",
    model: {
      id: "gpt-4.1",
      name: "GPT-4.1",
      api: "openai-responses",
      provider: "github-copilot",
      baseUrl: "https://api.githubcopilot.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    auth: {
      apiKey: "prepared-github-token",
      profileId: "github:work",
      source: "profile",
      mode: "oauth",
    },
    sourceAuthFingerprint: "prepared-owner-fingerprint",
  },
  config: {},
  agentId: "test",
  agentDir: "/tmp/agent",
  workspaceDir: "/workspace",
  systemPrompt: "Answer only from the supplied prompt.",
  prompt: "What is two plus two?",
  timeoutMs: 1000,
} satisfies AgentHarnessIsolatedCompletionParams;

describe("runCopilotIsolatedCompletion deadline clock", () => {
  // Fake only Date/setTimeout/clearTimeout so performance.now() stays
  // monotonic — the production fix seeds and reads the deadline on that
  // clock, while the consumer setTimeout is also monotonic. A wall-clock
  // shift must not alter the remaining budget.
  it.each([
    { direction: "backward", shift: -5_000 },
    { direction: "forward", shift: 5_000 },
  ])(
    "keeps a stalled acquire on the configured deadline after a $direction wall-clock shift",
    async ({ shift }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const pool: CopilotClientPool = {
          acquire: async () => await new Promise<never>(() => {}),
          release: async () => {},
          dispose: async () => [],
          size: () => 0,
        };
        const getPool = async () => {
          vi.setSystemTime(Date.now() + shift);
          return pool;
        };

        let settled: unknown;
        const run = runCopilotIsolatedCompletion(ISOLATED_COMPLETION_PARAMS, getPool).catch(
          (error: unknown) => {
            settled = error;
          },
        );
        // The deadline is the configured 1000ms. A forward wall-clock shift must
        // not reject the acquire before it elapses — the pre-fix Date.now()
        // remaining budget would go negative and reject on microtask flush, so
        // asserting the completion is still pending here distinguishes reaching
        // the deadline from early rejection.
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBeUndefined();
        // The deadline timer (not the early-rejection guard) must fire it.
        await vi.advanceTimersByTimeAsync(1000);
        await run;
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toMatch(/timed out after 1000ms/);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
