import {
  mintMcpLoopbackClientGrant,
  revokeMintedMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import type { MemoryAudience } from "../../plugins/memory-provider-types.js";
import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";

type CliMcpClientGrantParams = Omit<
  Parameters<typeof mintMcpLoopbackClientGrant>[0],
  "memoryAudience"
> & {
  /** The turn's own resolution; the turn keeps custody of its leases. */
  turnAudience?: { memoryAudience?: MemoryAudience };
};

/**
 * Mint the run-bound loopback grant for one admitted CLI turn, carrying that turn's
 * host memory audience. A turn that already resolved its audience passes it as
 * `turnAudience`, so the grant and the turn's hooks share one resolution. Otherwise
 * the grant resolves its own, and the returned cleanup revokes the grant and releases
 * that audience's session leases together; it runs once, at run end or failed preparation.
 */
export async function mintCliMcpClientGrant(
  run: Parameters<typeof resolveCliMcpMemoryAudience>[0],
  agentId: string,
  { turnAudience, ...params }: CliMcpClientGrantParams,
): Promise<{ grant: ReturnType<typeof mintMcpLoopbackClientGrant>; cleanup: () => Promise<void> }> {
  const { memoryAudience, release } = turnAudience
    ? { memoryAudience: turnAudience.memoryAudience, release: () => {} }
    : await resolveCliMcpMemoryAudience(run, {
        agentId,
        sessionKey: params.context.sessionKey,
      });
  let grant: ReturnType<typeof mintMcpLoopbackClientGrant>;
  try {
    grant = mintMcpLoopbackClientGrant({
      ...params,
      ...(memoryAudience ? { memoryAudience } : {}),
    });
  } catch (error) {
    release();
    throw error;
  }
  let revoked = false;
  return {
    grant,
    cleanup: async () => {
      if (revoked) {
        return;
      }
      revoked = true;
      revokeMintedMcpLoopbackClientGrant(grant);
      release();
    },
  };
}
