import { formatErrorMessage } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { getActiveMemoryProvider, type MemoryHealth } from "openclaw/plugin-sdk/memory-host-search";
import { normalizePluginsConfig } from "openclaw/plugin-sdk/plugin-config-runtime";

const MEMORY_CORE_PLUGIN_ID = "memory-core";

/** Selected memory provider facts reported while Memory Core runs only as a sidecar. */
export type SelectedMemoryProviderStatus = {
  agentId: string;
  provider: string;
  health: MemoryHealth;
  memoryCore: "consolidation-sidecar";
};

/** Returns the plugin that owns the memory slot when it is not Memory Core. */
export function resolveForeignMemorySlotOwner(cfg: OpenClawConfig): string | undefined {
  const owner = normalizePluginsConfig(cfg.plugins).slots.memory;
  return typeof owner === "string" && owner !== MEMORY_CORE_PLUGIN_ID ? owner : undefined;
}

/** Explains that a Memory Core command touches only its sidecar index. */
export function formatMemoryCoreSidecarNotice(owner: string): string {
  return `Memory Core is running as the consolidation sidecar; plugins.slots.memory selects "${owner}". This command acts on Memory Core's sidecar index, not the agent's selected memory.`;
}

/**
 * Reads the selected provider's health with host status authority, the same
 * contract the host status scan uses, and always releases the provider lease.
 */
export async function readSelectedMemoryProviderStatus(params: {
  cfg: OpenClawConfig;
  agentId: string;
  owner: string;
}): Promise<SelectedMemoryProviderStatus> {
  const { cfg, agentId, owner } = params;
  let provider: Awaited<ReturnType<typeof getActiveMemoryProvider>>["provider"] = null;
  let providerId = owner;
  let health: MemoryHealth;
  try {
    const acquired = await getActiveMemoryProvider({
      cfg,
      agentId,
      purpose: "status",
      context: { authority: { kind: "host", operation: "status" }, assertCurrent() {} },
    });
    provider = acquired.provider;
    health = provider
      ? await provider.health()
      : { status: "unavailable", message: acquired.error ?? "memory provider unavailable" };
    providerId = acquired.providerId ?? owner;
  } catch (error) {
    health = { status: "unavailable", message: formatErrorMessage(error) };
  } finally {
    await provider?.close().catch(() => {});
  }
  return { agentId, provider: providerId, health, memoryCore: "consolidation-sidecar" };
}
