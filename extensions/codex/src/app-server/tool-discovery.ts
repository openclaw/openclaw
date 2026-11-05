import { closeCodexStartupClientBestEffort } from "./attempt-client-cleanup.js";
import { withCodexStartupTimeout } from "./attempt-timeouts.js";
import type { CodexAppServerClient } from "./client.js";
import { listAllCodexAppServerModels, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS } from "./models.js";
import { requestCodexAppServerClientJson } from "./request.js";
import type { CodexAppServerScopedRequest } from "./request.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexAppServerClientFactory,
  type CodexAppServerClientOptions,
} from "./shared-client.js";

/** Membership is a bounded proxy, not a native tool_mode capability guarantee. */
export async function isCodexModelListedOnConnection(params: {
  request: CodexAppServerScopedRequest;
  model: string;
  signal: AbortSignal;
}): Promise<boolean> {
  try {
    const catalog = await listAllCodexAppServerModels({
      request: params.request,
      includeHidden: true,
    });
    params.signal.throwIfAborted();
    return catalog.models.some((entry) => entry.model === params.model);
  } catch {
    params.signal.throwIfAborted();
    return false;
  }
}

export function createCodexToolDiscoveryRequest(params: {
  client: CodexAppServerClient;
  signal: AbortSignal;
  timeoutMs: number;
  assertCurrent: () => void;
}): CodexAppServerScopedRequest {
  const deadline = Date.now() + Math.min(params.timeoutMs, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS);
  return async (request) => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Codex tool discovery catalog deadline exceeded");
    }
    return await requestCodexAppServerClientJson({
      ...request,
      ...params,
      timeoutMs: remainingMs,
    });
  };
}

/** Acquire the actual startup lease before catalog-dependent prompt preparation. */
export async function acquireCodexToolDiscoveryClient(params: {
  factory: CodexAppServerClientFactory;
  callerOwnedAttemptClient?: boolean;
  options: CodexAppServerClientOptions;
  timeoutMs: number;
  signal: AbortSignal;
  onTimeout: () => void;
}): Promise<{ client: CodexAppServerClient; release: () => void }> {
  const ownsClient =
    params.callerOwnedAttemptClient || params.factory === createIsolatedCodexAppServerClient;
  const retireAbandonedClient = async (client: CodexAppServerClient | undefined) => {
    if (ownsClient) {
      await closeCodexStartupClientBestEffort(client);
    } else if (client && retireSharedCodexAppServerClientIfCurrent(client)?.closed) {
      // A borrowed custom client has no entry; only the shared owner may retire it.
      await client.closeAndWait();
    }
  };
  const abandon = new AbortController();
  const signal = AbortSignal.any([params.signal, abandon.signal]);
  let abandoned = false;
  let observedClient: CodexAppServerClient | undefined;
  let acquired: { client: CodexAppServerClient; release: () => void } | undefined;
  try {
    return await withCodexStartupTimeout({
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onTimeout: () => {
        abandon.abort();
        params.onTimeout();
      },
      operation: async () => {
        const client = await params.factory({
          ...params.options,
          abandonSignal: signal,
          onStartedClient: (started) => {
            // A shared process still belongs to its service before lease acquisition.
            if (params.factory !== getLeasedSharedCodexAppServerClient) {
              observedClient = started;
              if (abandoned) {
                void retireAbandonedClient(started);
              }
            }
          },
        });
        let released = false;
        acquired = {
          client,
          release: () => {
            if (released) {
              return;
            }
            released = true;
            if (ownsClient) {
              client.close();
            } else {
              releaseLeasedSharedCodexAppServerClient(client);
            }
          },
        };
        if (abandoned || signal.aborted) {
          acquired.release();
          await retireAbandonedClient(client);
          signal.throwIfAborted();
        }
        return acquired;
      },
    });
  } catch (error) {
    abandoned = true;
    abandon.abort();
    acquired?.release();
    await retireAbandonedClient(acquired?.client ?? observedClient);
    throw error;
  }
}
