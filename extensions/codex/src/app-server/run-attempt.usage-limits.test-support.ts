import path from "node:path";
import { AgentHarnessModelRequestPolicyError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import { readCodexRateLimitsRevision, rememberCodexRateLimitsRead } from "./rate-limit-cache.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
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
function exhaustedLimit(resetsAt: number, limitId = "codex", windowDurationMins = 300) {
  return {
    limitId,
    primary: { usedPercent: 100, windowDurationMins, resetsAt },
    rateLimitReachedType: "rate_limit_reached",
  };
}
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
    it("keeps a confirmed denial through native finalization, history rows, and lifecycle events", async () => {
      const harness = createStartedThreadHarness(async () => undefined);
      const params = createUsageParams("model-policy-denial-agent");
      saveAuthProfileStore(params.authProfileStore, params.agentDir);
      const onAgentEvent = vi.fn();
      const run = runCodexAppServerAttempt({ ...params, onAgentEvent });
      await waitForRequest(harness, run, "turn/start");
      await harness.notify(rateLimitsUpdated(Math.ceil(Date.now() / 1000) + 120));
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "Partial reply",
        },
      });
      const message =
        'unexpected status 403 Forbidden: {"error":"middleware_denied","reason_code":"request_credential_denied","layer":"l7","detail":"PRIVATE-BODY"}, request id: PRIVATE-ID';
      await harness.notify({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
          error: { message, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } },
        },
      });
      await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: { message } }));
      const result = await run;
      const expected =
        "The deployment rejected this model request. Ask the administrator to check the model access policy and request settings.";
      expect(result.lastAssistant).toMatchObject({
        stopReason: "error",
        errorCode: "model_request_policy_denied",
        errorMessage: expected,
      });
      expect(onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "lifecycle",
          data: expect.objectContaining({
            error: expected,
            errorObservation: expect.objectContaining({
              httpStatus: 403,
              providerErrorCode: "model_request_policy_denied",
            }),
          }),
        }),
      );
      expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
      expect(JSON.stringify(result.lastAssistant)).not.toContain("PRIVATE");
    });

    it.each([
      "incomplete",
      "retry",
      "other-turn",
      "notification-only",
      "rpc-overload",
      "rpc-invalid",
    ] as const)("uses coherent startup facts from %s", async (source) => {
      const willRetry = source === "retry";
      const notificationOnly = source === "notification-only";
      const rpcCode =
        source === "rpc-overload" ? -32001 : source === "rpc-invalid" ? -32602 : undefined;
      const message =
        'unexpected status 403 Forbidden: {"error":"middleware_denied","reason_code":"request_credential_denied","layer":"l7"}';
      // Identical text must not let a prior notice replace an explicit RPC rejection.
      const rpcMessage = source === "rpc-invalid" ? message : "ordinary RPC refusal";
      const harness: Harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          await harness.notify({
            method: "error",
            params: {
              threadId: "thread-1",
              turnId: source === "other-turn" || rpcCode !== undefined ? "previous-turn" : "turn-1",
              willRetry,
              error: {
                message,
                ...(source !== "incomplete"
                  ? { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } }
                  : {}),
              },
            },
          });
          if (rpcCode !== undefined) {
            throw new CodexAppServerRpcError({ code: rpcCode, message: rpcMessage }, "turn/start");
          }
          if (notificationOnly) {
            throw new Error(message);
          }
          throw Object.assign(new Error("ordinary RPC refusal"), {
            data: {
              error: {
                message: "ordinary RPC refusal",
                codexErrorInfo: {
                  httpConnectionFailed: { httpStatusCode: source === "incomplete" ? 403 : 401 },
                },
              },
            },
          });
        }
        return undefined;
      });
      const run = runCodexAppServerAttempt(createUsageParams());
      if (rpcCode !== undefined) {
        await expect(run).rejects.toMatchObject({ code: rpcCode, message: rpcMessage });
        return;
      }
      const result = await run;
      expect(readAttemptTerminal(result).promptError).toMatchObject({
        status: source === "incomplete" || notificationOnly ? 403 : 401,
      });
      expect(
        readAttemptTerminal(result).promptError instanceof AgentHarnessModelRequestPolicyError,
      ).toBe(notificationOnly);
      if (!notificationOnly) {
        expect(readAttemptTerminal(result).promptError).toMatchObject({
          message: "ordinary RPC refusal",
        });
      }
    });

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

    it.each(["primary", "unrelated"] as const)(
      "preserves reset details with a %s startup update",
      async (source) => {
        const resetsAt = Math.ceil(Date.now() / 1000) + 120;
        const primary = source === "primary";
        const unrelated = {
          method: "account/rateLimits/updated",
          params: { rateLimits: exhaustedLimit(resetsAt + 60, "codex_other", 60) },
        };
        const harness: Harness = createStartedThreadHarness(async (method) => {
          if (method === "turn/start") {
            const revision = readCodexRateLimitsRevision(harness.client);
            await harness.notify(primary ? rateLimitsUpdated(resetsAt) : unrelated);
            if (primary) {
              expect(readCodexRateLimitsRevision(harness.client)).toBe(revision + 1);
            }
            throwUsageError();
          }
          return undefined;
        });
        if (!primary) {
          rememberCodexRateLimitsRead(harness.client, { rateLimits: exhaustedLimit(resetsAt) });
        }
        const params = createUsageParams(primary ? "agent" : undefined);
        const result = await runCodexAppServerAttempt(params);
        if (primary) {
          expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
          expectResetError(result);
        } else {
          expect(expectUsageLimitPromptError(result).message).toContain("Next reset in");
          expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBeUndefined();
        }
      },
    );

    it.each([true, null])(
      "does not block a refreshed account with ordinary permission %s and 100%% usage",
      async (ordinaryUsageAllowed) => {
        const resetsAt = Math.ceil(Date.now() / 1000) + 120;
        const harness = createStartedThreadHarness(async (method) => {
          if (method === "turn/start") {
            throwUsageError();
          }
          if (method === "account/rateLimits/read") {
            return {
              ordinaryUsageAllowed,
              rateLimits: {
                ...exhaustedLimit(resetsAt),
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
      await harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: usageError }));

      const result = await run;

      const promptError = expectResetError(result);
      expect(promptError.message).not.toContain("Codex did not return a reset time");
      expect(params.authProfileStore.usageStats?.["openai:work"]?.blockedUntil).toBe(
        resetsAt * 1000,
      );
      expectRateRead(harness, true);
    });

    it.each([
      { error: usageError, blocked: true },
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
