export type EmbeddedAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model: unknown;
  thinkingLevel: unknown;
  tools: readonly unknown[];
  customTools: readonly unknown[];
  sessionManager: unknown;
  settingsManager: unknown;
  resourceLoader: unknown;
};

export async function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
  createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
  options: EmbeddedAgentSessionOptions;
}): Promise<Result> {
  return await params.createAgentSession(params.options);
}
