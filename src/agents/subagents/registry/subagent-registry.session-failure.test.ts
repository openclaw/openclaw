import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import * as runtimeConfig from "../../../config/runtime-snapshot.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createSubagentRunRecord,
  expectRecordFields,
} from "../../subagent-test-fixtures.test-helpers.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

afterEach(runtimeConfig.clearRuntimeConfigSnapshot);
it.each([
  ["error", false],
  ["timeout", false],
  ["error", true],
] as const)(
  "persists a bounded %s reason and child notice (interrupted=%s)",
  (outcomeStatus, interrupted) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      runtimeConfig.setRuntimeConfigSnapshot({});
      const target = {
        agentId: "main",
        sessionKey: "agent:main:subagent:setup-failure",
        sessionId: "sess-setup-failure",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await sessions.upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
      });
      const reason = `Repository base ref is missing. ${"details ".repeat(80)}`.trim();
      const record = createSubagentRunRecord({
        runId: "run-setup-failure",
        childSessionKey: target.sessionKey,
        createdAt: 1_000,
        startedAt: 1_001,
        endedAt: 2_000,
        outcome: {
          status: outcomeStatus,
          error: `[tool calls omitted]\n<final>${reason}</final>`,
        },
      });
      record.execution.interruptionReason = interrupted ? "gateway-restart" : undefined;
      const persist = (overrides: Partial<SubagentRunRecord> = {}) =>
        persistSubagentSessionTiming({ ...record, ...overrides });
      const read = () => sessions.loadSessionEntry(target);
      await persist();
      expect(read()).toMatchObject({
        status: interrupted ? "interrupted" : outcomeStatus === "error" ? "failed" : "timeout",
        lastRunError: interrupted
          ? "Run interrupted by a Gateway restart."
          : expect.stringContaining("Repository base ref is missing."),
        ...(interrupted ? { abortedLastRun: true } : {}),
      });
      const lastRunError = read()?.lastRunError;
      expect(lastRunError?.length).toBeLessThanOrEqual(160);
      await persist();
      const notices = (await sessions.loadTranscriptEvents(target)).filter(
        (event) => isRecord(event) && event.type === "custom_message",
      );
      const notice = {
        customType: "run-failed-before-reply",
        display: true,
        details: { runId: record.runId, error: reason.slice(0, 512) },
      };
      expect(notices).toMatchObject(interrupted ? [] : [notice]);
      for (const status of ["running", "queued"] as const) {
        await persist({ execution: { status } });
        expectRecordFields(read(), { lastRunError, status: undefined });
      }
      await persist({ endedReason: "subagent-killed" });
      expect(read()?.lastRunError).toBe(lastRunError);
      await persist({ execution: { ...record.execution, outcome: { status: "ok" } } });
      expectRecordFields(read(), { lastRunError: undefined, abortedLastRun: undefined });
    }),
);
