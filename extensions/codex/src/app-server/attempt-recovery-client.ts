import type { CodexAppServerClient } from "./client.js";
import {
  createIsolatedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";

export function createCodexAttemptClientLease(
  client: CodexAppServerClient,
  factory: CodexAppServerClientFactory,
): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (factory === createIsolatedCodexAppServerClient) {
      client.close();
    } else {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  };
}

/** Reacquire the admitted runtime without transferring startup cleanup ownership. */
export function createCodexRecoveryClientAcquirer(params: {
  attemptClientFactory: CodexAppServerClientFactory;
  clientOptions: Parameters<CodexAppServerClientFactory>[0];
  assertCurrent?: () => void;
  verifyArtifact: (client: CodexAppServerClient, signal: AbortSignal) => Promise<unknown>;
  initializeRuntime: (client: CodexAppServerClient) => void;
}) {
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const client = await params.attemptClientFactory({
      ...params.clientOptions,
      abandonSignal: signal,
      onStartedClient: undefined,
    });
    const release = createCodexAttemptClientLease(client, params.attemptClientFactory);
    try {
      signal.throwIfAborted();
      params.assertCurrent?.();
      await params.verifyArtifact(client, signal);
      signal.throwIfAborted();
      params.assertCurrent?.();
      params.initializeRuntime(client);
      return { client, release };
    } catch (error) {
      release();
      throw error;
    }
  };
}
