import path from "node:path";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import { rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import {
  createTestParams,
  createStartedThreadHarness,
  rateLimitsUpdated,
  runCodexAppServerAttempt,
  tempDir,
} from "./run-attempt-test-harness.js";

type Harness = ReturnType<typeof createStartedThreadHarness>;
const usageError = {
  message: "You've reached your usage limit.",
  codexErrorInfo: "usageLimitExceeded",
};
const resetTime = () => Math.ceil(Date.now() / 1000) + 120;
const exhaustedLimit = (resetsAt: number, limitId = "codex", windowDurationMins = 300) => ({
  limitId,
  primary: { usedPercent: 100, windowDurationMins, resetsAt },
  rateLimitReachedType: "rate_limit_reached",
});
function throwUsageError(): never {
  throw Object.assign(new Error(usageError.message), {
    data: { codexErrorInfo: usageError.codexErrorInfo },
  });
}
function startFailure(onStart: () => void | Promise<void>, read?: () => unknown) {
  return createStartedThreadHarness(async (method) => {
    if (method === "turn/start") {
      await onStart();
    }
    return method === "account/rateLimits/read" ? read?.() : undefined;
  });
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
function expectLimit(
  result: Awaited<ReturnType<typeof runCodexAppServerAttempt>>,
  params: ReturnType<typeof createUsageParams>,
  blockedUntil?: number,
) {
  const error = readAttemptTerminal(result).promptError;
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ status: 429 });
  expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBe(blockedUntil);
  return error as Error;
}
async function startStored(harness: Harness, method = "turn/start") {
  const params = createUsageParams("stored-usage-agent");
  saveAuthProfileStore(params.authProfileStore, params.agentDir);
  const run = runCodexAppServerAttempt(params);
  await awaitGateBeforeSettlement(
    harness.waitForMethod(method),
    run,
    `Codex attempt settled before ${method}`,
  );
  return { params, run };
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
        startFailure(() => {
          throw Object.assign(new Error(message), { data: { error: { message, codexErrorInfo } } });
        });
        const params = createUsageParams();
        const result = await runCodexAppServerAttempt(params);
        expect(readAttemptTerminal(result)).toMatchObject({
          promptErrorSource: "prompt",
          promptError: { message, status },
        });
        expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
        expect(result.replayMetadata.replaySafe).toBe(true);
      },
    );

    it.each(["primary", "unrelated"] as const)(
      "preserves reset details with a %s startup update",
      async (source) => {
        const resetsAt = resetTime();
        const primary = source === "primary";
        const harness: Harness = startFailure(async () => {
          await harness.notify(
            primary
              ? rateLimitsUpdated(resetsAt)
              : {
                  method: "account/rateLimits/updated",
                  params: { rateLimits: exhaustedLimit(resetsAt + 60, "codex_other", 60) },
                },
          );
          throwUsageError();
        });
        if (!primary) {
          rememberCodexRateLimitsRead(harness.client, { rateLimits: exhaustedLimit(resetsAt) });
        }
        const params = createUsageParams(primary ? "agent" : undefined);
        const result = await runCodexAppServerAttempt(params);
        // The primary startup update is trusted; an unrelated update must not block this profile.
        const error = readAttemptTerminal(result).promptError;
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          status: 429,
          message: expect.stringContaining("Next reset in"),
        });
        if (primary) {
          expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
        } else {
          expectLimit(result, params);
        }
      },
    );

    it.each([true, null])(
      "does not block a refreshed account with ordinary permission %s and 100%% usage",
      async (ordinaryUsageAllowed) => {
        const resetsAt = resetTime();
        const harness = startFailure(throwUsageError, () => ({
          ordinaryUsageAllowed,
          rateLimits: {
            ...exhaustedLimit(resetsAt),
            secondary: null,
            rateLimitReachedType: null,
          },
        }));
        const { params, run } = await startStored(harness, "account/rateLimits/read");
        const result = await run;
        expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
        const error = expectLimit(result, params);
        expect(error.message).toContain(
          ordinaryUsageAllowed === null
            ? "could not determine a reset time"
            : "current account usage does not report an exhausted limit",
        );
      },
    );

    it.each([
      { source: "refresh", error: usageError, blocked: true },
      { source: "notification", error: usageError, blocked: true },
      {
        source: "notification",
        error: {
          message: "Too many requests; please retry later.",
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
        blocked: false,
      },
    ])(
      "blocks only native usage exhaustion from $source limits: $blocked",
      async ({ source, error, blocked }) => {
        const resetsAt = resetTime();
        const refresh = source === "refresh";
        const harness = createStartedThreadHarness(async (method) =>
          refresh && method === "account/rateLimits/read"
            ? rateLimitsUpdated(resetsAt).params
            : undefined,
        );
        const { params, run } = await startStored(harness);
        if (!refresh) {
          await harness.notify(rateLimitsUpdated(resetsAt));
        }
        await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error }));
        expect(
          expectLimit(await run, params, blocked ? resetsAt * 1000 : undefined).message,
        ).toContain(blocked ? "Next reset in" : error.message);
      },
    );
  });
}
