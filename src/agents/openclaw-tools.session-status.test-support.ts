import { expect, type vi } from "vitest";

export function expectSpawnedSessionLookupCalls(
  gateway: ReturnType<typeof vi.fn>,
  spawnedBy: string,
  targetKeys: string[],
) {
  const lookups = gateway.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === "sessions.resolve");
  expect(lookups).toEqual(
    targetKeys.map((key) => ({
      method: "sessions.resolve",
      params: { agentId: "main", allowMissing: true, key, spawnedBy },
    })),
  );
}

export const createMockConfig = () => ({
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
});

export function fixedStoreConfig() {
  return {
    session: { mainKey: "main", scope: "global", store: "/tmp/shared-sessions.sqlite" },
    agents: {
      ownership: "explicit",
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
        sessionStore: { agentId: "ops" },
      },
      entries: { ops: {}, research: {} },
    },
    tools: { agentToAgent: { enabled: false } },
  };
}
