import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type Input = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];
export type RetryRunParams = Input["runInput"]["runParams"];

export function createRetryController({
  agentDir = "/tmp/openclaw-failover-retry-controller-test",
  runParams = {},
  runtime = {},
  fallbackConfigured = false,
}: {
  agentDir?: string;
  runParams?: Partial<RetryRunParams>;
  runtime?: Partial<Input["preparedRuntime"]>;
  fallbackConfigured?: boolean;
} = {}) {
  const params: RetryRunParams = {
    runId: "run:retry-test",
    sessionId: "session:failover-retry-controller-test",
    sessionFile: "/tmp/openclaw-failover-retry-controller-test/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "synthetic auth failure",
    timeoutMs: 60_000,
    ...runParams,
  };
  return createEmbeddedRunFailoverRetryController({
    runInput: {
      runParams: params,
      globalLane: "test",
      agentDir,
      fallbackConfigured,
      startedAtMs: Date.now(),
    },
    preparedRuntime: {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      profileFailureStore: { version: 1, profiles: {} },
      snapshot: () => ({
        lastProfileId: "openai:p1",
        pluginHarnessOwnsTransport: false,
        agentHarness: { id: "embedded" },
      }),
      getApiKeyInfo: () => null,
      advanceAttemptAuthProfile: async () => false,
      ...runtime,
    },
    getSessionId: () => params.sessionId,
  });
}
