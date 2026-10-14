import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const compactRuntimeLoader = createLazyImportLoader(() => import("./compact.js"));

export async function compactEmbeddedAgentSessionOnDemand(
  params: CompactEmbeddedAgentSessionRuntimeParams,
): Promise<EmbeddedAgentCompactResult> {
  const { compactEmbeddedAgentSessionDirect } = await compactRuntimeLoader.load();
  return compactEmbeddedAgentSessionDirect(params);
}
