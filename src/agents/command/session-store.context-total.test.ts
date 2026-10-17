// Verifies that run finalization supersedes the per-call context totals a run publishes.
import { describe, expect, it } from "vitest";
import {
  resolveFreshSessionTotalTokens,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import {
  createRunResult,
  loadPersistedSessionEntry,
  seedSessionStore,
  updateSessionStoreAfterAgentRun,
  withTempSessionStore,
} from "./session-store.test-support.js";

const sessionId = "context-total-session";
const sessionKey = "agent:main:explicit:context-total-session";

describe("updateSessionStoreAfterAgentRun context total", () => {
  it.each([
    {
      name: "the finished run's total",
      initial: {
        totalTokens: 900,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      lastCallUsage: { input: 120_000, output: 50, total: 120_050 },
      expected: 120_000,
    },
    {
      name: "unknown when the final call has no context snapshot",
      initial: {},
      lastCallUsage: { input: 9_000, output: 5, contextUsage: { state: "unavailable" as const } },
      expected: undefined,
    },
  ])(
    "replaces per-call totals published during the run with $name",
    async ({ initial, lastCallUsage, expected }) => {
      await withTempSessionStore(async ({ storePath }) => {
        const entry: SessionEntry = { sessionId, updatedAt: 1, ...initial };
        await seedSessionStore(storePath, { [sessionKey]: entry });
        const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
        // A per-call publication changes the row under this run's snapshot.
        await seedSessionStore(storePath, {
          [sessionKey]: {
            ...entry,
            totalTokens: 185_000,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
            updatedAt: 2,
          },
        });
        await updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          result: createRunResult({
            sessionId,
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 300_000, output: 900, total: 300_900 },
            lastCallUsage,
          }),
        });
        expect(
          resolveFreshSessionTotalTokens(loadPersistedSessionEntry(storePath, sessionKey)),
        ).toBe(expected);
      });
    },
  );
});
