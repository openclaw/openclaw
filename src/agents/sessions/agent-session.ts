import { AgentSessionExecution } from "./agent-session-execution.js";
import type { AgentSessionConfig } from "./agent-session-types.js";
import type { ExtensionRunner } from "./extensions/index.js";

export * from "./agent-session-types.js";

/**
 * Core abstraction for agent lifecycle and session management.
 *
 * Shared by interactive, print, and RPC modes. Mode-specific I/O stays above
 * this class while the feature layers below own session behavior.
 */
export class AgentSession extends AgentSessionExecution {
  constructor(config: AgentSessionConfig) {
    super(config);
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
    this.installAgentToolHooks();
    this.buildRuntime({
      activeToolNames: [...this.allowedToolNames],
    });
  }

  get extensionRunner(): ExtensionRunner {
    return this.currentExtensionRunner;
  }
}
