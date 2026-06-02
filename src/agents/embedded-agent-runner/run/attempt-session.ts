import type { CreateAgentSessionOptions } from "../../sessions/index.js";

/**
 * Session options passed through the embedded runner's resource-loader seam.
 * Keep this shape aligned with CreateAgentSessionOptions fields that the runner
 * intentionally owns so tests can prove the exact injected resourceLoader path.
 */
export type EmbeddedAgentSessionOptions = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model: unknown;
  thinkingLevel: unknown;
  tools: NonNullable<CreateAgentSessionOptions["tools"]>;
  customTools: NonNullable<CreateAgentSessionOptions["customTools"]>;
  sessionManager: unknown;
  settingsManager: unknown;
  resourceLoader: unknown;
  withSessionWriteLock?: CreateAgentSessionOptions["withSessionWriteLock"];
};

/**
 * Create an embedded agent session while preserving the exact options object
 * assembled by the runner.
 *
 * This wrapper is intentionally thin: tests assert the resourceLoader and
 * session-write-lock seams cross this boundary without being reconstructed.
 */
export async function createEmbeddedAgentSessionWithResourceLoader<Result>(params: {
  createAgentSession: (options: EmbeddedAgentSessionOptions) => Promise<Result> | Result;
  options: EmbeddedAgentSessionOptions;
}): Promise<Result> {
  return await params.createAgentSession(params.options);
}
