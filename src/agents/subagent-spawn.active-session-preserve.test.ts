// Subagent spawn active-session-preserve tests verify that session-store writes
// initiated during subagent spawn forward the requester (parent) session key as
// `opts.activeSessionKey`. Session-store maintenance uses that key to protect
// the active human conversation from eviction when the store is at capacity.
//
// Regression: without this, `capEntryCount` could evict the unprotected active
// DM entry when protected external threads (Slack channels, Telegram topics,
// etc.) already filled `session.maintenance.maxEntries`.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

const REQUESTER_INTERNAL_KEY = "agent:main:main";

describe("spawnSubagentDirect active session key forwarding", () => {
  let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
  let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  it("forwards the requester session key as opts.activeSessionKey on every store write", async () => {
    // Capture the opts arg of every updateSessionStore call so we can assert
    // maintenance sees the active (parent) session key and treats it as
    // preserved during capEntryCount.
    const capturedOpts: Array<{ activeSessionKey?: string } | undefined> = [];
    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
        opts?: { activeSessionKey?: string },
      ) => {
        capturedOpts.push(opts);
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "test-active-session-preserve",
        // Provide an explicit resolved model to exercise the runtime-model
        // persistence path (`persistInitialChildSessionRuntimeModel`), which
        // is a second store write beyond the initial child-session patch.
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: REQUESTER_INTERNAL_KEY,
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    // At least the initial child-session patch and the runtime-model persist
    // call should have run; both must forward activeSessionKey. The exact
    // number of writes can grow with future patches, so assert on every call.
    expect(capturedOpts.length).toBeGreaterThanOrEqual(2);
    for (const opts of capturedOpts) {
      expect(opts?.activeSessionKey).toBe(REQUESTER_INTERNAL_KEY);
    }
  });
});
