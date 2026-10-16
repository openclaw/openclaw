import {
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { resolveCliMcpMemoryAudience } from "./mcp-memory-audience.js";

type CliMcpClientGrantParams = Omit<
  Parameters<typeof mintMcpLoopbackClientGrant>[0],
  "memoryAudience"
>;

/**
 * Mint the run-bound loopback grant for one admitted CLI turn, carrying that turn's
 * host memory audience. The returned cleanup revokes the grant and releases the
 * audience's session leases together; it runs once, at run end or failed preparation.
 */
export async function mintCliMcpClientGrant(
  run: Parameters<typeof resolveCliMcpMemoryAudience>[0],
  agentId: string,
  params: CliMcpClientGrantParams,
): Promise<{ grant: ReturnType<typeof mintMcpLoopbackClientGrant>; cleanup: () => Promise<void> }> {
  const { memoryAudience, release } = await resolveCliMcpMemoryAudience(run, {
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
      revokeMcpLoopbackClientGrant(grant.token);
      release();
    },
  };
}
