import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { operatorRefusalText, textResult } from "openclaw/plugin-sdk/tool-results";

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
 * Why a turn's memory tools and automatic recall may not use stored memories, or undefined
 * when they may. Both inputs are fixed for the turn: the audience the host minted when it
 * admitted the turn, and `ownerOnly` as the plugin registered it. `false` opens stored
 * memories to every session, as before this rule.
 */
export function resolveStoredMemoryDenial(
  audience: MemoryAudience,
  agentId: string,
  ownerOnly: boolean,
): string | undefined {
  return ownerOnly ? resolveSessionMemoryDenial(audience, agentId) : undefined;
}

/** The result of a refused memory tool call. `action` names the refused work. */
export function storedMemoriesRefusal(action: string) {
  return textResult(operatorRefusalText("owner-private-memory", action), {
    status: "blocked",
    reason: "owner_private_memory",
  });
}
