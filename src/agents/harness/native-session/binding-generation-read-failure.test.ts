import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import * as sessionRead from "../../../config/sessions/session-entry-current-check.js";
import { resolveCronRunErrorReason } from "../../../cron/run-error-reason.js";
import { normalizeCronRunErrorText } from "../../../cron/service/execution-errors.js";
import { resolveTransientCronRetryDecision } from "../../../cron/service/timer-trigger.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { AgentHarnessSessionSupersededError } from "../errors.js";
import {
  reclaimNativeSessionGenerationWithAuthority,
  retainNativeSessionGenerationAuthority,
} from "./binding-generation-authority.js";

afterEach(() => vi.restoreAllMocks());

const target = { agentId: "main", sessionKey: "agent:main:synthetic", sessionId: "synthetic" };
const createSupersededError = () => new AgentHarnessSessionSupersededError("synthetic superseded");

it.each(["retain", "reclaim"] as const)(
  "preserves an actual unavailable-store read failure before %s admission",
  async (entry) => {
    const state = await createOpenClawTestState({ layout: "state-only", applyEnv: false });
    try {
      const blocked = path.join(state.stateDir, "synthetic-not-a-directory");
      await fs.writeFile(blocked, "synthetic fixture");
      const storePath = path.join(blocked, "sessions.json");
      const original = await sessionRead
        .captureSessionEntryCurrentCheckAsyncInternal({
          ...target,
          storePath,
          matchGeneration: false,
          fields: ["sessionId", "previousSessionId"],
        })
        .catch((error: unknown) => error);
      assert(original instanceof Error);
      const prepareReclaim = vi.fn(async () => ({ kind: "resolved" as const, result: true }));
      const params = { target, storePath, createSupersededError };
      const outcome = await (
        entry === "retain"
          ? retainNativeSessionGenerationAuthority(params)
          : reclaimNativeSessionGenerationWithAuthority({
              ...params,
              generation: {
                prepareReclaim,
                adopt: async () => "absent" as const,
                reclaim: async () => true,
              },
            })
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(AgentHarnessSessionSupersededError);
      expect(outcome).toMatchObject({ name: original.name, message: original.message });
      expect(prepareReclaim).not.toHaveBeenCalled();
    } finally {
      await state.cleanup();
    }
  },
);

it("retains the concrete local timeout through native admission and cron retry classification", async () => {
  const timeout = new WorkerTaskError("Synthetic session reader timed out", "timeout");
  vi.spyOn(sessionRead, "captureSessionEntryCurrentCheckAsyncInternal").mockRejectedValueOnce(
    timeout,
  );
  const outcome = await retainNativeSessionGenerationAuthority({
    target,
    storePath: "/synthetic/session-reader/sessions.json",
    createSupersededError,
  }).catch((error: unknown) => error);
  expect(outcome).toBe(timeout);
  const reason = resolveCronRunErrorReason(outcome, "openai");
  expect(reason).toBeUndefined();
  expect(
    resolveTransientCronRetryDecision({
      error: normalizeCronRunErrorText(outcome),
      executionStarted: false,
      consecutiveErrors: 1,
    }),
  ).toMatchObject({ retryable: true, reason: "transient retry", retryCategory: "timeout" });
});
