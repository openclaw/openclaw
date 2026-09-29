import { beforeAll, expect, it } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  ensureAuthProfileStoreMock,
  getApiKeyForModelMock,
  loadCompactHooksHarness,
  selectAgentHarnessForPreparedModelProvidersMock,
  selectAgentHarnessMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:plugin-auth-compaction";
const fixture = useCompactHooksSessionFixture(sessionKey);
let loaded: Awaited<ReturnType<typeof loadCompactHooksHarness>>;
let storePath: string;

beforeAll(async () => {
  loaded = await loadCompactHooksHarness();
  storePath = await fixture.prepare();
});

it("reports unsupported host compaction when the selected plugin owns authentication", async () => {
  const session = await fixture.prepareSession();
  const harness: AgentHarness = {
    id: "plugin-auth",
    label: "Plugin auth",
    authBootstrap: "plugin",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("not used");
    },
  };
  selectAgentHarnessMock.mockReturnValue(harness);
  selectAgentHarnessForPreparedModelProvidersMock.mockReturnValue(harness);
  ensureAuthProfileStoreMock.mockImplementation(() => {
    throw new Error("provider auth store is unavailable");
  });
  getApiKeyForModelMock.mockImplementation(() => {
    throw new Error("provider credential is unavailable");
  });

  const result = await loaded.compactEmbeddedAgentSessionDirect({
    agentId: "main",
    sessionId: session.sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: {
      agentId: "main",
      sessionId: session.sessionId,
      sessionKey,
      storePath,
    },
    workspaceDir: session.workspaceDir,
    provider: "openai",
    model: "fixture-primary",
    modelFallbacksOverride: [],
    enqueue: async (task) => await task(),
  });

  expect(result).toMatchObject({
    ok: false,
    compacted: false,
    failure: { reason: "unsupported_harness_compaction" },
    reason: expect.stringContaining('Agent harness "plugin-auth" owns authentication'),
  });
});
