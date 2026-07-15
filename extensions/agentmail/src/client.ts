import { AgentMailClient } from "agentmail";
import type { ResolvedAgentMailAccount } from "./types.js";

export function createAgentMailClient(account: ResolvedAgentMailAccount): AgentMailClient {
  return new AgentMailClient({ apiKey: account.apiKey });
}
