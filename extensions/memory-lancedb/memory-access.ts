import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { textResult } from "openclaw/plugin-sdk/tool-results";

type MemoryAudience = OpenClawPluginToolContext["memoryAudience"];

/**
 * Stored memories belong to the agent owner. A session reads or forgets them only under a
 * host-minted owner-private audience for that same agent: the owner's direct chats and the
 * sessions and scheduled runs that inherit one. Returns why a session is refused, or undefined.
 */
export function resolveSessionMemoryDenial(
  audience: MemoryAudience,
  agentId: string,
): string | undefined {
  if (audience?.kind !== "owner-private") {
    return "this session has no owner-private memory audience";
  }
  if (normalizeAgentId(audience.agentId) !== agentId) {
    return "the memory audience belongs to another agent";
  }
  return undefined;
}

/**
 * Why a session's memory tools and automatic recall may not use stored memories, or undefined
 * when they may. `ownerOnly: false` opens them to every session, as before this rule.
 */
export function resolveStoredMemoryDenial(
  audience: MemoryAudience,
  agentId: string,
  config: { ownerOnly?: boolean },
): string | undefined {
  return config.ownerOnly === false ? undefined : resolveSessionMemoryDenial(audience, agentId);
}

/** The tool result for a refused session: the reason and the next step that applies to it. */
export function storedMemoriesUnavailableResult(audience: MemoryAudience, denial: string) {
  const nextStep =
    audience?.kind === "conversation"
      ? "They are used only in the agent owner's direct chats. An operator can set ownerOnly: false in the memory-lancedb config to use them in every conversation."
      : "If this is the owner's session, check that commands.ownerAllowFrom lists the owner (openclaw doctor prints the command). Sessions without a chat, such as unlinked scheduled jobs, never get them.";
  return textResult(`Stored memories are not available in this session: ${denial}. ${nextStep}`, {
    status: "blocked",
    reason: "owner_private_memory",
    denial,
  });
}
