import type { CliDeps } from "../../cli/deps.js";
import type {
  AgentCommandIngressOpts,
  AgentCommandIngressResult,
} from "../../commands/agent/types.js";
import type { RuntimeEnv } from "../../runtime.js";

export type AgentRunBackend = "legacy" | "embedded" | "acp" | "chutes";

export type AgentRunSource = "agent-command" | "gateway";

export type AgentRunIdentity = {
  runId: string;
  sessionKey?: string;
  idempotencyKey?: string;
};

export type AgentRunRequest = {
  source: AgentRunSource;
  backend?: AgentRunBackend;
  identity?: Partial<AgentRunIdentity>;
  opts: AgentCommandIngressOpts;
  runtime?: RuntimeEnv;
  deps?: CliDeps;
};

export type AgentRunResult = AgentCommandIngressResult & {
  identity: AgentRunIdentity;
  backend: AgentRunBackend;
};
