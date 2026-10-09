import {
  normalizeExtraMemoryPathEntries,
  type MemoryExtraPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  defaultRuntime,
  formatCliJsonFailure,
  formatErrorMessage,
  getMemoryEmbeddingCommandSecretTargetIds,
  resolveCommandSecretRefsViaGateway,
  shortenHomePath,
  theme,
  withManager,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import {
  listAgentIds,
  resolveConfiguredAgentId,
  getRuntimeConfig,
  resolveDefaultAgentId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMemoryCoreSidecarNotice, resolveForeignMemorySlotOwner } from "./cli-memory-slot.js";
import type { MemoryCommandOptions } from "./cli.types.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import { getMemorySearchManager } from "./memory/index.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import type { ShortTermAuditSummary } from "./short-term-promotion.js";
const { warn } = theme;
export type MemoryManager = NonNullable<
  Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]
>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];
function isMemorySecretOwnerFailure(error: unknown, message: string): boolean {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (
    candidate.ownerKind === "capability" &&
    typeof candidate.ownerId === "string" &&
    candidate.ownerId.startsWith("memory-provider:")
  ) {
    return true;
  }
  if (
    Array.isArray(candidate.paths) &&
    candidate.paths.some(
      (entry) => typeof entry === "string" && entry.includes("memory.search.remote.apiKey"),
    )
  ) {
    return true;
  }
  // Gateway RPC errors preserve the typed owner's redacted message even when
  // structured owner fields are unavailable to the CLI process.
  return message.includes("capability:memory-provider:");
}
async function loadMemoryCommandConfig(
  commandName: string,
  mode?: "enforce_resolved" | "read_only_status",
) {
  const config = getRuntimeConfig({ skipPluginValidation: true });
  try {
    const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
      config,
      commandName,
      targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
      ...(mode ? { mode } : {}),
    });
    return { config: resolvedConfig, diagnostics };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const message = formatErrorMessage(error);
    if (
      mode !== "read_only_status" ||
      isMemorySecretOwnerFailure(error, message) ||
      (code !== "SECRET_SURFACE_UNAVAILABLE" && !message.includes("SECRET_SURFACE_UNAVAILABLE"))
    ) {
      throw error;
    }
    return {
      config,
      diagnostics: [
        `${commandName}: ${message}; continuing with degraded read-only config so healthy memory surfaces remain visible.`,
      ],
    };
  }
}
function emitMemorySecretResolveDiagnostics(
  diagnostics: string[],
  params?: { json?: boolean },
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const toStderr = params?.json === true;
  for (const entry of diagnostics) {
    const message = warn(`[secrets] ${entry}`);
    if (toStderr) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}
/** Tells the operator that a Memory Core command acts on its sidecar index only. */
export function emitMemoryCoreSidecarNotice(owner: string, params?: { json?: boolean }): void {
  const message = warn(formatMemoryCoreSidecarNotice(owner));
  if (params?.json) {
    defaultRuntime.error(message);
  } else {
    defaultRuntime.log(message);
  }
}
export function resolveMemoryPluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asNullableRecord(cfg.plugins?.entries?.["memory-core"]);
  return asNullableRecord(entry?.config) ?? {};
}
export function formatAuditCounts(audit: ShortTermAuditSummary): string {
  const coverage = audit.conceptTagScripts;
  const scriptCoverage = coverage
    ? (["latin", "cjk", "mixed", "other"] as const)
        .flatMap((script) => {
          const count = coverage[`${script}EntryCount`];
          return count > 0 ? [`${count} ${script}`] : [];
        })
        .join(", ")
    : "";
  const suffix = scriptCoverage ? ` · scripts=${scriptCoverage}` : "";
  return `${audit.entryCount} entries · ${audit.promotedCount} promoted · ${audit.conceptTaggedEntryCount} concept-tagged · ${audit.spacedEntryCount} spaced${suffix}`;
}
export function resolveMemoryAgent(cfg: OpenClawConfig, agent?: string) {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    throw new Error("--agent must not be blank");
  }
  return trimmed ? resolveConfiguredAgentId(cfg, trimmed) : resolveDefaultAgentId(cfg);
}
export function resolveMemoryAgentIds(cfg: OpenClawConfig, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    throw new Error("--agent must not be blank");
  }
  return trimmed ? [resolveConfiguredAgentId(cfg, trimmed)] : listAgentIds(cfg);
}
export function formatExtraPaths(workspaceDir: string, extraPaths: MemoryExtraPath[]): string[] {
  return normalizeExtraMemoryPathEntries(workspaceDir, extraPaths).map((entry) => {
    const root = shortenHomePath(entry.path);
    return entry.pattern ? `${root} (pattern: ${entry.pattern})` : root;
  });
}
export async function withMemoryCommand(params: {
  commandName: string;
  options: Pick<MemoryCommandOptions, "agent" | "json">;
  allAgents?: boolean;
  purpose?: MemoryManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
  /** Refuse instead of answering from the sidecar index when another plugin owns the slot. */
  requiresMemorySlot?: boolean;
  run: (context: { manager: MemoryManager; cfg: OpenClawConfig; agentId: string }) => Promise<void>;
}): Promise<OpenClawConfig> {
  const { agent, json } = params.options;
  // Status owns one aggregate document; single-agent commands report acquisition failures here.
  const onUnavailable = json && !params.allAgents ? defaultRuntime.writeJson : undefined;
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig(
    params.commandName,
    params.purpose === "status" ? "read_only_status" : undefined,
  );
  emitMemorySecretResolveDiagnostics(diagnostics, { json });
  const slotOwner = resolveForeignMemorySlotOwner(cfg);
  if (slotOwner && params.requiresMemorySlot) {
    const message = `${params.commandName} reads only Memory Core's sidecar index, but plugins.slots.memory selects "${slotOwner}". Search the selected memory through the agent's memory tools or the ${slotOwner} plugin's own commands.`;
    defaultRuntime.error(message);
    process.exitCode = 1;
    onUnavailable?.({
      ...formatCliJsonFailure(message),
      agentId: resolveMemoryAgent(cfg, agent),
    });
    return cfg;
  }
  if (slotOwner) {
    emitMemoryCoreSidecarNotice(slotOwner, { json });
  }
  const agentIds = params.allAgents
    ? resolveMemoryAgentIds(cfg, agent)
    : [resolveMemoryAgent(cfg, agent)];
  for (const agentId of agentIds) {
    await withManager<MemoryManager>({
      getManager: () =>
        getMemorySearchManager({
          cfg,
          agentId,
          purpose: params.purpose,
          inspectSources: params.inspectSources,
          acquireLocalService: params.acquireLocalService,
          runInBackgroundContext: params.runInBackgroundContext,
        }),
      onMissing: (error) => {
        if (!error?.trim()) {
          defaultRuntime.log("Memory search disabled.");
          onUnavailable?.({ agentId, status: "disabled" });
          return;
        }
        const message = `${params.commandName} failed (${agentId}): ${error}`;
        defaultRuntime.error(message);
        process.exitCode = 1;
        onUnavailable?.({ ...formatCliJsonFailure(message), agentId });
      },
      onCloseError: (err) =>
        defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
      close: async (manager) => {
        await manager.close?.();
      },
      run: async (manager) => params.run({ manager, cfg, agentId }),
    });
  }
  return cfg;
}
type SourceScan = {
  source: "memory" | "sessions";
  totalFiles: number | null;
  issues: string[];
};
export type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};
export async function scanMemoryManagerSources(
  status: ReturnType<MemoryManager["status"]>,
): Promise<MemorySourceScan | undefined> {
  if (!status.sourceCounts?.length) {
    return undefined;
  }
  const sources = status.sourceCounts.map((entry): SourceScan => ({
    source: entry.source,
    totalFiles: entry.eligible ?? null,
    issues: entry.issues ?? [],
  }));
  const totalFiles = sources.some((entry) => entry.totalFiles === null)
    ? null
    : sources.reduce((total, entry) => total + (entry.totalFiles ?? 0), 0);
  return { sources, totalFiles, issues: sources.flatMap((entry) => entry.issues) };
}

export function formatMemoryIndexOutcome(
  status: ReturnType<MemoryManager["status"]>,
  scan: MemorySourceScan | undefined,
  agentId: string,
): string {
  const indexedFiles = status.files ?? 0;
  if (indexedFiles === 0 && status.workspaceDir && scan?.totalFiles === 0) {
    return `No memory files found in ${shortenHomePath(status.workspaceDir)}; nothing indexed (${agentId}).`;
  }
  const fileLabel = indexedFiles === 1 ? "file" : "files";
  return `Memory index updated (${agentId}): ${indexedFiles} ${fileLabel} indexed.`;
}
