export function createWorkerFixture(agentWorkspace?: { agentId: string; remoteRoot: string }) {
  return {
    ...(agentWorkspace ? { agentWorkspace } : {}),
    model: {
      provider: "openai",
      id: "worker-model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      contextWindow: 8192,
      maxTokens: 1024,
    },
  };
}
