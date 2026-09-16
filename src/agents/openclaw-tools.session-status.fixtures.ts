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

export function createScopedSessionStores() {
  // Two stores simulate per-agent session files selected by scoped status lookups.
  return new Map<string, Record<string, unknown>>([
    [
      "/tmp/main/sessions.json",
      {
        "agent:main:main": { sessionId: "s-main", updatedAt: 10 },
      },
    ],
    [
      "/tmp/support/sessions.json",
      {
        main: { sessionId: "s-support", updatedAt: 20 },
      },
    ],
  ]);
}
