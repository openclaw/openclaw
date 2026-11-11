import {
  mintMcpLoopbackClientGrant,
  revokeMintedMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";

/** Mint the projected grant; caller resources own its already-resolved memory audience. */
export function mintCliMcpClientGrant(params: Parameters<typeof mintMcpLoopbackClientGrant>[0]): {
  grant: ReturnType<typeof mintMcpLoopbackClientGrant>;
  cleanup: () => Promise<void>;
} {
  const grant = mintMcpLoopbackClientGrant(params);
  let revoked = false;
  return {
    grant,
    cleanup: async () => {
      if (revoked) {
        return;
      }
      revoked = true;
      revokeMintedMcpLoopbackClientGrant(grant);
    },
  };
}
