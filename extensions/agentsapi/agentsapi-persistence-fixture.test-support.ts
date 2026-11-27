import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import {
  createAttempt,
  createBindingStore,
  externalSessionFixture,
  mockClient,
  registerHarness,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";

function harnessScope<T extends object>(
  create: () => ReturnType<typeof registerHarness>,
  fixture: T,
) {
  let harness: ReturnType<typeof registerHarness> | undefined;
  return Object.assign(
    {
      get harness() {
        return (harness ??= create());
      },
      async dispose() {
        await harness?.dispose();
        harness = undefined;
      },
      async restart() {
        await this.dispose();
        await reopenState();
      },
    },
    fixture,
  );
}

async function createFixture(
  state: OpenClawTestState,
  sessionId: string,
  config: () => OpenClawConfig,
) {
  const params = await createAttempt(state.stateDir);
  const openStore = <T = AgentsApiBinding>() => createBindingStore<T>(state.env);
  const scope = harnessScope(() => registerHarness(state.env, config), {
    params,
    ...mockClient(sessionId),
    openStore,
  });
  return Object.assign(scope, {
    run: async (overrides: Partial<AgentHarnessAttemptParamsV2> = {}) => {
      const result = await scope.harness.runAttempt({ ...params, ...overrides });
      expect(result).toMatchObject({ terminal: { kind: "ok" } });
      return result;
    },
  });
}

export function withPersistenceFixture(
  sessionId: string,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  config: () => OpenClawConfig = () => ({}),
) {
  return withOpenClawTestState({ label: "agentsapi-persistence" }, async (state) => {
    const fixture = await createFixture(state, sessionId, config);
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
    }
  });
}

async function createNativeFixture(state: OpenClawTestState) {
  const fixture = await externalSessionFixture(state);
  return harnessScope(fixture.createHarness, {
    ...fixture,
    target: { ...fixture.params.sessionTarget, assertCurrent: () => {} },
    binding: () => fixture.openStore().lookup(fixture.params.sessionId),
  });
}

export function withNativeFixture(
  run: (fixture: Awaited<ReturnType<typeof createNativeFixture>>) => Promise<void>,
) {
  return withOpenClawTestState({ label: "agentsapi-native-lifecycle" }, async (state) => {
    const fixture = await createNativeFixture(state);
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
    }
  });
}
