import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assertAgentHarnessExecutionEnvironment } from "./execution-environment.js";
import type { AgentHarness } from "./types.js";

it("reads native consent in the worker and observes a committed revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:native-consent";
    const scope = { agentId: "main", sessionKey };
    const harness: AgentHarness = {
      id: "fixture",
      label: "Fixture",
      executionEnvironment: "host-only",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused");
      },
    };
    const params = {
      sessionKey,
      sessionId: "native-consent",
      agentId: "main",
      permissionMode: "full" as const,
      config: { agents: { defaults: { sandbox: { mode: "all" as const } } } },
    };
    await upsertSessionEntryCore(scope, {
      sessionId: params.sessionId,
      updatedAt: 1,
      sandboxMode: "off",
      permissionMode: "full",
      agentRuntimeOverride: harness.id,
      nativeRuntimeConsent: harness.id,
    });
    const calls = observeMainThreadSql();
    try {
      await expect(assertAgentHarnessExecutionEnvironment(harness, params)).resolves.toBe(true);
      calls.expectIdle();
    } finally {
      calls.restore();
    }
    await upsertSessionEntryCore(scope, {
      sandboxMode: undefined,
      nativeRuntimeConsent: undefined,
    });
    const revokedCalls = observeMainThreadSql();
    try {
      await expect(assertAgentHarnessExecutionEnvironment(harness, params)).rejects.toThrow(
        "outside the sandbox",
      );
      revokedCalls.expectIdle();
    } finally {
      revokedCalls.restore();
    }
  });
});
