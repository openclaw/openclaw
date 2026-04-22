import {
  listActiveMemoryPublicArtifacts,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/memory-host-core";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawConfig } from "../api.js";

export async function ensureMemoryWikiPublicArtifactsRuntime(
  appConfig?: OpenClawConfig,
): Promise<void> {
  if (!appConfig) {
    return;
  }

  if ((await listActiveMemoryPublicArtifacts({ cfg: appConfig })).length > 0) {
    return;
  }

  try {
    await getActiveMemorySearchManager({
      cfg: appConfig,
      agentId: resolveDefaultAgentId(appConfig),
      purpose: "status",
    });
  } catch {
    // Best-effort bootstrap only. The subsequent public artifact lookup remains
    // the source of truth and should gracefully report zero artifacts when the
    // active memory plugin is unavailable.
  }
}
