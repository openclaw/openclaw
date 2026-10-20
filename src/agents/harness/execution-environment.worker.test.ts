import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assertAgentHarnessExecutionEnvironment } from "./execution-environment.js";
import type { AgentHarness } from "./types.js";

const harness: AgentHarness = {
  id: "fixture",
  label: "Fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  runAttempt: async () => {
    throw new Error("unused");
  },
};
const sandbox = { mode: "all" as const };
const check = (params: Parameters<typeof assertAgentHarnessExecutionEnvironment>[1]) =>
  expect(assertAgentHarnessExecutionEnvironment(harness, params));

async function withoutMainThreadSql(run: () => Promise<void>) {
  const calls = observeMainThreadSql();
  try {
    await run();
    calls.expectIdle();
  } finally {
    calls.restore();
  }
}

it("reads native consent in the worker and observes a committed revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:native-consent";
    const scope = { agentId: "main", sessionKey };
    const params = {
      sessionKey,
      sessionId: "native-consent",
      agentId: "main",
      permissionMode: "full" as const,
      config: { agents: { defaults: { sandbox } } },
    };
    await upsertSessionEntryCore(scope, {
      sessionId: params.sessionId,
      updatedAt: 1,
      sandboxMode: "off",
      permissionMode: "full",
      agentRuntimeOverride: harness.id,
      nativeRuntimeConsent: harness.id,
    });
    await withoutMainThreadSql(async () => {
      await check(params).resolves.toBe(true);
    });
    await upsertSessionEntryCore(scope, {
      sandboxMode: undefined,
      nativeRuntimeConsent: undefined,
    });
    await withoutMainThreadSql(async () => {
      await check(params).rejects.toThrow("outside the sandbox");
    });
  });
});

it("evaluates agent-scoped remembered consent each turn without copying it into the session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = {
      agents: {
        defaults: { sandbox },
        entries: { main: { nativeRuntimeConsent: ["fixture"] } },
      },
    };
    setRuntimeConfigSnapshot(config);
    const scope = { agentId: "main", sessionKey: "agent:main:remembered-native" };
    const params = {
      ...scope,
      sessionId: "remembered-native",
      permissionMode: "full" as const,
      config,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: params.sessionId,
      updatedAt: 1,
      sandboxMode: "off",
      permissionMode: "full",
    });
    await check(params).resolves.toBe(true);
    for (const overrides of [{ toolsAllow: ["read"] }, { disableTools: true }]) {
      await check({ ...params, ...overrides }).resolves.not.toBe(true);
    }
    await check({ ...params, permissionMode: "guarded" }).rejects.toThrow("requires Full access");
    await upsertSessionEntryCore(scope, { sandboxMode: undefined });
    await check(params).rejects.toThrow("outside the sandbox");
    await upsertSessionEntryCore(scope, { sandboxMode: "off" });
    config.agents.entries.main.nativeRuntimeConsent = [];
    await check(params).resolves.toBe(false);
  });
});
