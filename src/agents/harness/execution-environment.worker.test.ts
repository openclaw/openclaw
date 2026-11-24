import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { expectNoMainThreadSql as withoutMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
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

async function createSession(
  sessionId: string,
  config: OpenClawConfig,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}` };
  const update = (value: Parameters<typeof upsertSessionEntryCore>[1]) =>
    upsertSessionEntryCore(scope, value);
  await update({ sessionId, updatedAt: 1, sandboxMode: "off", permissionMode: "full", ...entry });
  return { update, params: { ...scope, sessionId, permissionMode: "full" as const, config } };
}

it("reads native consent in the worker and observes a committed revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const { params, update } = await createSession(
      "native-consent",
      { agents: { defaults: { sandbox } } },
      {
        agentRuntimeOverride: harness.id,
        nativeRuntimeConsent: harness.id,
      },
    );
    await withoutMainThreadSql(() => check(params).resolves.toBe(true));
    await update({ sandboxMode: undefined, nativeRuntimeConsent: undefined });
    await withoutMainThreadSql(() => check(params).rejects.toThrow("outside the sandbox"));
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
    const { params, update } = await createSession("remembered-native", config);
    await check(params).resolves.toBe(true);
    for (const overrides of [{ toolsAllow: ["read"] }, { disableTools: true }]) {
      await check({ ...params, ...overrides }).resolves.not.toBe(true);
    }
    await check({ ...params, permissionMode: "guarded" }).rejects.toThrow("requires Full access");
    await update({ sandboxMode: undefined });
    await check(params).rejects.toThrow("outside the sandbox");
    await update({ sandboxMode: "off" });
    config.agents.entries.main.nativeRuntimeConsent = [];
    await check(params).resolves.toBe(false);
  });
});
