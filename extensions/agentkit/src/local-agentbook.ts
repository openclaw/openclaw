import type { AgentBookVerifier } from "./agentkit.runtime.js";

export const DEFAULT_AGENTKIT_LOCAL_HUMAN_PREFIX = "local-human";

export function createTrustVerifiedSignerAgentBookVerifier(
  prefix = DEFAULT_AGENTKIT_LOCAL_HUMAN_PREFIX,
): AgentBookVerifier {
  return {
    async lookupHuman(address: string) {
      return `${prefix}:${address.toLowerCase()}`;
    },
  };
}
