import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import { resolveEmbeddedAttemptMemoryAudience } from "../embedded-agent-runner/run/attempt-memory-audience.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Resolve the memory audience for one admitted CLI turn's run-bound loopback grant.
 * Uses the native runner's host resolver over the turn's admitted session row; the
 * returned release ends the turn-owned session leases and must run at run end.
 */
export async function resolveCliMcpMemoryAudience(
  run: Pick<
    RunCliAgentParams,
    "config" | "sessionId" | "senderIsOwner" | "sessionEntry" | "sessionTarget" | "storePath"
  > & { assertCurrent?: () => void },
  grant: { agentId: string; sessionKey: string },
): Promise<{ memoryAudience?: MemoryAudience; release: () => void }> {
  const storePath = run.sessionTarget?.storePath ?? run.storePath;
  return await resolveEmbeddedAttemptMemoryAudience({
    config: run.config,
    agentId: grant.agentId,
    sessionKey: grant.sessionKey,
    sessionId: run.sessionId,
    senderIsOwner: run.senderIsOwner,
    // Without an admitted row and its store there is no verified lineage to resolve.
    admission: run.sessionEntry && storePath ? { entry: run.sessionEntry, storePath } : undefined,
    assertCallerCurrent: run.assertCurrent,
  });
}
