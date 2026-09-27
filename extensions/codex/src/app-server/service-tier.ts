import type { CodexAppServerClient } from "./client.js";
import { listAllCodexAppServerModels } from "./models.js";
import type { CodexServiceTier } from "./protocol.js";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
} from "./request.js";

/** Optional speed upgrades follow this turn's native model and authenticated client. */
export async function resolveCodexUltrafastServiceTier(params: {
  enabled: boolean;
  serviceTier?: CodexServiceTier | null;
  model?: string;
  modelProvider?: string;
  client: CodexAppServerClient;
  timeoutMs: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  config?: Parameters<typeof requestCodexAppServerClientJson>[0]["config"];
}): Promise<CodexServiceTier | null | undefined> {
  if (!params.enabled || params.modelProvider !== "openai" || !params.model) {
    return params.serviceTier;
  }
  params.signal.throwIfAborted();
  params.assertCurrent();
  const deadline = Date.now() + params.timeoutMs;
  try {
    const catalog = await listAllCodexAppServerModels({
      includeHidden: true,
      request: (request) => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) {
          throw new Error("Codex Ultrafast catalog deadline exceeded");
        }
        return requestCodexAppServerClientJson({
          ...request,
          client: params.client,
          signal: params.signal,
          assertCurrent: params.assertCurrent,
          timeoutMs,
          config: params.config,
        });
      },
    });
    params.signal.throwIfAborted();
    params.assertCurrent();
    // Match the request's model slug, not a catalog alias for another native model.
    const model = catalog.models.find((entry) => entry.model === params.model);
    return model?.serviceTiers?.includes("ultrafast") ? "ultrafast" : params.serviceTier;
  } catch (error) {
    params.signal.throwIfAborted();
    params.assertCurrent();
    if (error instanceof CodexAppServerScopedRequestRejectedError) {
      throw error;
    }
    // An unavailable or malformed optional catalog must not erase the baseline tier.
    return params.serviceTier;
  }
}
