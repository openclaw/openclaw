import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

export async function compactEmbeddedAgentSessionOnDemand(
  params: CompactEmbeddedAgentSessionRuntimeParams,
): Promise<EmbeddedAgentCompactResult> {
  const { compactEmbeddedAgentSessionDirect } = await compactRuntimeLoader.load();
  const result = await compactEmbeddedAgentSessionDirect(params);
  if (result.failure) {
    readCompactionAccountingRecorder(params.contextEngineRuntimeContext)?.recordFailure?.(
      result.failure,
    );
  }
  return result;
}
