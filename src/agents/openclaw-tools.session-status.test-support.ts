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
