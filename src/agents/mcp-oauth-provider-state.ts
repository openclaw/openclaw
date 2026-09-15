import type { McpOAuthMutation, McpOAuthStore } from "./mcp-oauth-store.types.js";

/** Lifecycle-owned metadata for the SDK's synchronous getters. */
export function createMcpOAuthProviderState(operations: {
  read: () => Promise<McpOAuthStore>;
  mutate: (mutation: McpOAuthMutation) => Promise<{ store: McpOAuthStore; applied: boolean }>;
}) {
  let prepared: { redirectUrl?: string } | { error: unknown } = {};
  let preparation = 0;
  let nextWrite = 0;
  let lastSettledWrite = 0;
  const settleWrite = (write: number, value: typeof prepared) => {
    if (write < lastSettledWrite) {
      return;
    }
    lastSettledWrite = write;
    // Reads dispatched before settlement may still carry the pre-write snapshot.
    preparation++;
    prepared = value;
  };
  return {
    async readStore(this: void) {
      const currentPreparation = ++preparation;
      const store = await operations.read();
      if (currentPreparation === preparation) {
        prepared = { redirectUrl: store.redirectUrl };
      }
      return store;
    },
    async updateStore(this: void, mutation: McpOAuthMutation) {
      preparation++;
      const write = ++nextWrite;
      try {
        const { store } = await operations.mutate(mutation);
        settleWrite(write, { redirectUrl: store.redirectUrl });
        return store;
      } catch (error) {
        // A possible commit invalidates earlier reads until a new read is acknowledged.
        settleWrite(write, { error });
        throw error;
      }
    },
    preparedStore(this: void): { redirectUrl?: string } {
      if ("error" in prepared) {
        throw prepared.error;
      }
      return prepared;
    },
  };
}
