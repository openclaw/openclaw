import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
setupRunAttemptTestHooks();

describe("pending attempt Reserve route (mocked native server)", () => {
  it.each([true, false])(
    "routes only after native settings acceptance (accept=%s)",
    async (accepted) => {
      const sessionFile = path.join(tempDir, "reserve.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace"));
      params.modelId = "gpt-5.6-luna";
      params.model = { ...params.model, id: params.modelId };
      params.fastMode = false;
      let nativeModel = params.modelId;
      const harness = createStartedThreadHarness(async (method, raw) => {
        if (method === "thread/start") {
          return { ...threadStartResult(), model: nativeModel };
        }
        if (method === "account/rateLimits/read") {
          return {
            accountId: "account-a",
            rateLimitUpsell: {
              banner_type: "luna_reserve",
              title: "Reserve",
              description: "fixture",
              ctas: [],
              blocked_model_slug: "gpt-5.6-luna",
            },
            ordinaryUsageAllowed: false,
            rateLimits: {},
          };
        }
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-reserve",
                model: "gpt-reserve",
                displayName: "Reserve",
                description: "fixture",
                hidden: true,
                isDefault: false,
                inputModalities: ["text"],
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }],
                defaultReasoningEffort: "medium",
                serviceTiers: [],
                defaultServiceTier: null,
              },
            ],
            nextCursor: null,
          };
        }
        if (method === "thread/settings/update") {
          if (!accepted) {
            throw new Error("native settings rejected");
          }
          if (!isJsonObject(raw) || typeof raw.model !== "string") {
            throw new Error("invalid test params");
          }
          nativeModel = raw.model;
          await harness.notify({
            method: "thread/settings/updated",
            params: { threadId: "thread-1", threadSettings: raw },
          });
          return {};
        }
        if (method === "turn/start") {
          return turnStartResult("reserve-turn");
        }
        return undefined;
      });
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: path.join(tempDir, "agent") });
      recordCodexAppServerAuthHandoff(harness.client, {
        accessFingerprint: "fixture",
        chatgptAccountId: "account-a",
      });
      const operation = runCodexAppServerAttempt(params);
      if (!accepted) {
        await expect(operation).rejects.toThrow("native settings rejected");
        expect(harness.requests.some((r) => r.method === "turn/start")).toBe(false);
      } else {
        await harness.waitForMethod("turn/start");
        const start = harness.requests.find((r) => r.method === "turn/start");
        expect(start?.params).toMatchObject({ model: "gpt-reserve", serviceTier: null });
        const methods = harness.requests.map((r) => r.method);
        expect(methods.indexOf("thread/settings/update")).toBeLessThan(
          methods.indexOf("turn/start"),
        );
        await harness.completeTurn({ threadId: "thread-1", turnId: "reserve-turn" });
        const result = await operation;
        expect(result.runtimeModelSelection).toEqual({ provider: "openai", model: "gpt-reserve" });
      }
      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        reserveReturn: { accountId: "account-a", model: "gpt-5.6-luna" },
      });
    },
  );
});
