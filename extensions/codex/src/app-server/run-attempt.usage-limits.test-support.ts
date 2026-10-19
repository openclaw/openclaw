import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import { readCodexRateLimitsRevision, rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import {
  createTestParams,
  createStartedThreadHarness,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  tempDir,
} from "./run-attempt-test-harness.js";

type Harness = ReturnType<typeof createStartedThreadHarness>;
type Result = Awaited<ReturnType<typeof runCodexAppServerAttempt>>;

function expectUsageLimitPromptError(result: Result): Error & { status: 429 } {
  const value = readAttemptTerminal(result).promptError;
  expect(value).toBeInstanceOf(Error);
  const error = value as Error & { status?: unknown };
  expect(error.status).toBe(429);
  return error as Error & { status: 429 };
}

function createUsageParams(agentDirectory?: string) {
  return Object.assign(createTestParams(), {
    ...(agentDirectory ? { agentDir: path.join(tempDir, agentDirectory) } : {}),
    authProfileId: "openai:work",
    authProfileStore: {
      version: 1,
      profiles: {
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "placeholder",
          expires: Date.now() + 60_000,
        },
      },
    },
  } satisfies Partial<ReturnType<typeof createTestParams>>);
}

const usageError = {
  message: "You've reached your usage limit.",
  codexErrorInfo: "usageLimitExceeded",
};
function throwUsageError(): never {
  throw Object.assign(new Error(usageError.message), {
    data: { codexErrorInfo: usageError.codexErrorInfo },
  });
}
async function waitForRequest(
  harness: Harness,
  run: ReturnType<typeof runCodexAppServerAttempt>,
  method: string,
) {
  await awaitGateBeforeSettlement(
    harness.waitForMethod(method),
    run,
    `Codex attempt settled before ${method}`,
  );
}
function expectRateRead(harness: Harness, called: boolean) {
  expect(harness.requests.some(({ method }) => method === "account/rateLimits/read")).toBe(called);
}
function expectResetError(result: Result) {
  const error = expectUsageLimitPromptError(result);
  expect(error.message).toContain("You've reached your Codex subscription usage limit.");
  expect(error.message).toContain("Next reset in");
  return error;
}

export function registerCodexUsageLimitTests() {
  describe("runCodexAppServerAttempt usage limits", () => {
    it.each([
      { codexErrorInfo: "rateLimitExceeded", status: 429 },
      { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, status: 429 },
      { codexErrorInfo: "serverOverloaded", status: 503 },
    ])(
      "preserves native startup provider facts: $codexErrorInfo",
      async ({ codexErrorInfo, status }) => {
        const message = "The model is not available.";
        const harness = createStartedThreadHarness(async (method) => {
          if (method === "turn/start") {
            throw Object.assign(new Error(message), {
              data: { error: { message, codexErrorInfo } },
            });
          }
          return undefined;
        });

        const params = createUsageParams();
        const result = await runCodexAppServerAttempt(params);
        expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
        expect(readAttemptTerminal(result).promptError).toMatchObject({ message, status });
        expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
        expectRateRead(harness, false);
        expect(result.replayMetadata.replaySafe).toBe(true);
      },
    );

    it("preserves Codex usage-limit reset details when turn/start fails", async () => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const harness: Harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          const revisionBeforeUpdate = readCodexRateLimitsRevision(harness.client);
          await harness.notify(rateLimitsUpdated(resetsAt));
          expect(readCodexRateLimitsRevision(harness.client)).toBe(revisionBeforeUpdate + 1);
          throwUsageError();
        }
        return undefined;
      });

      const params = createUsageParams("agent");

      const result = await runCodexAppServerAttempt(params);
      expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
      expectResetError(result);
    });

    it("does not trust an unrelated in-turn rate-limit update for profile blocking", async () => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const harness: Harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          await harness.notify({
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex_other",
                primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: resetsAt + 60 },
                rateLimitReachedType: "rate_limit_reached",
              },
            },
          });
          throwUsageError();
        }
        return undefined;
      });
      rememberCodexRateLimitsRead(harness.client, {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
          rateLimitReachedType: "rate_limit_reached",
        },
      });
      const params = createUsageParams();

      const result = await runCodexAppServerAttempt(params);

      expect(expectUsageLimitPromptError(result).message).toContain("Next reset in");
      expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
    });

    it.each([
      { ordinaryUsageAllowed: true, usedPercent: 100 },
      { ordinaryUsageAllowed: null, usedPercent: 100 },
    ])(
      "does not block a refreshed account with ordinary permission $ordinaryUsageAllowed and $usedPercent% usage",
      async ({ ordinaryUsageAllowed, usedPercent }) => {
        const resetsAt = Math.ceil(Date.now() / 1000) + 120;
        const harness = createStartedThreadHarness(async (method) => {
          if (method === "turn/start") {
            throwUsageError();
          }
          if (method === "account/rateLimits/read") {
            return {
              ordinaryUsageAllowed,
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent, windowDurationMins: 300, resetsAt },
                secondary: null,
                rateLimitReachedType: null,
              },
            };
          }
          return undefined;
        });
        const params = createUsageParams("available-usage-limit-agent");
        saveAuthProfileStore(params.authProfileStore, params.agentDir);

        const run = runCodexAppServerAttempt(params);
        await waitForRequest(harness, run, "account/rateLimits/read");

        const result = await run;
        expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
        const promptError = expectUsageLimitPromptError(result);
        if (ordinaryUsageAllowed === null) {
          expect(promptError.message).toContain("could not determine a reset time");
          expect(promptError.message).not.toContain("Next reset");
          expect(promptError.message).not.toContain("does not report an exhausted limit");
        } else {
          expect(promptError.message).toContain(
            "current account usage does not report an exhausted limit",
          );
          expect(promptError.message).not.toContain("subscription usage limit");
          expect(promptError.message).not.toContain("could not determine a reset time");
        }
        expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
      },
    );

    it("refreshes Codex account rate limits when a failed turn omits reset details", async () => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "account/rateLimits/read") {
          return rateLimitsUpdated(resetsAt).params;
        }
        return undefined;
      });

      const params = createUsageParams("streamed-usage-limit-agent");
      saveAuthProfileStore(params.authProfileStore, params.agentDir);
      const run = runCodexAppServerAttempt(params);
      await waitForRequest(harness, run, "turn/start");
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "failed",
          error: usageError,
        }),
      );

      const result = await run;

      const promptError = expectResetError(result);
      expect(promptError.message).not.toContain("Codex did not return a reset time");
      expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBe(
        resetsAt * 1000,
      );
      expectRateRead(harness, true);
    });

    it.each([
      {
        error: usageError,
        blocked: true,
      },
      {
        error: {
          message: "Too many requests; please retry later.",
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
        blocked: false,
      },
    ])(
      "blocks only native usage exhaustion with trusted in-turn limits: $blocked",
      async ({ error, blocked }) => {
        const resetsAt = Math.ceil(Date.now() / 1000) + 120;
        const harness = createStartedThreadHarness(async () => undefined);
        const params = createUsageParams("trusted-streamed-usage-limit-agent");
        saveAuthProfileStore(params.authProfileStore, params.agentDir);

        const run = runCodexAppServerAttempt(params);
        await waitForRequest(harness, run, "turn/start");
        await harness.notify(rateLimitsUpdated(resetsAt));
        await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error }));

        const result = await run;

        expect(expectUsageLimitPromptError(result).message).toContain(
          blocked ? "Next reset in" : error.message,
        );
        expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBe(
          blocked ? resetsAt * 1000 : undefined,
        );
        expectRateRead(harness, false);
      },
    );
  });
}
