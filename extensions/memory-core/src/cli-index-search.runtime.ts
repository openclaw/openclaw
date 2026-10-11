import path from "node:path";
import {
  defaultRuntime,
  formatErrorMessage,
  setVerbose,
  shortenHomeInString,
  theme,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { getRuntimeConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveForeignMemorySlotOwner } from "./cli-memory-slot.js";
import {
  emitMemoryCoreSidecarNotice,
  formatExtraPaths,
  formatMemoryIndexOutcome,
  resolveMemoryAgent,
  scanMemoryManagerSources,
  syncMemoryWithProgress,
  withMemoryCommand,
} from "./cli-runtime-common.js";
import { renderMemorySearch } from "./cli-search-output.js";
import type {
  MemoryCommandOptions,
  MemoryForgetCommandOptions,
  MemorySearchCommandOptions,
} from "./cli.types.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { searchMemoryForCli } from "./memory-search-operation.js";
import { formatMemoryVectorDegradedWriteReason } from "./memory/manager-vector-warning.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
const { heading, info, muted, warn } = theme;
function formatSourceLabel(source: string, workspaceDir: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    return "sessions (current transcripts + retained transcript artifacts)";
  }
  return source;
}
export async function runMemoryIndex(
  opts: MemoryCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  setVerbose(Boolean(opts.verbose));
  await withMemoryCommand({
    commandName: "memory index",
    options: { agent: opts.agent },
    allAgents: true,
    purpose: "cli",
    inspectSources: true,
    ...hostOptions,
    run: async ({ manager, agentId }) => {
      try {
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (opts.verbose) {
          const status = manager.status();
          const label = (text: string) => muted(`${text}:`);
          const sourceLabels = (status.sources ?? []).map((source) =>
            formatSourceLabel(source, status.workspaceDir ?? ""),
          );
          const extraPaths = status.workspaceDir
            ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
            : [];
          const requestedProvider = status.requestedProvider ?? status.provider;
          const modelLabel = status.model ?? status.provider;
          const lines = [
            `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
            `${label("Provider")} ${info(status.provider)} ${muted(
              `(requested: ${requestedProvider})`,
            )}`,
            `${label("Model")} ${info(modelLabel)}`,
            sourceLabels.length ? `${label("Sources")} ${info(sourceLabels.join(", "))}` : null,
            extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
          ].filter(Boolean) as string[];
          if (status.fallback) {
            lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
          }
          defaultRuntime.log(lines.join("\n"));
          defaultRuntime.log("");
        }
        if (!syncFn) {
          defaultRuntime.log("Memory backend does not support manual reindex.");
          return;
        }
        await syncMemoryWithProgress({ sync: syncFn, options: opts, elapsed: true });
        let postIndexStatus = manager.status();
        const scan = await scanMemoryManagerSources(postIndexStatus);
        const outcome = formatMemoryIndexOutcome(postIndexStatus, scan, agentId);
        let semanticVectorAvailable = postIndexStatus.vector?.semanticAvailable;
        const vectorStoreAvailable =
          postIndexStatus.vector?.storeAvailable ?? postIndexStatus.vector?.available;
        if (
          postIndexStatus.backend === "builtin" &&
          (postIndexStatus.vector?.enabled ?? false) &&
          semanticVectorAvailable === undefined &&
          vectorStoreAvailable !== false &&
          typeof manager.probeVectorAvailability === "function"
        ) {
          semanticVectorAvailable = await manager.probeVectorAvailability();
          postIndexStatus = manager.status();
          semanticVectorAvailable =
            postIndexStatus.vector?.semanticAvailable ?? semanticVectorAvailable;
        }
        const vectorEnabled = postIndexStatus.vector?.enabled ?? false;
        const vectorAvailable =
          semanticVectorAvailable ??
          postIndexStatus.vector?.semanticAvailable ??
          postIndexStatus.vector?.available ??
          postIndexStatus.vector?.storeAvailable;
        const vectorLoadErr = postIndexStatus.vector?.loadError;
        defaultRuntime.log(outcome);
        if (vectorEnabled && vectorAvailable === false) {
          // Indexing still persisted chunks/FTS state; keep the command successful but
          // emit a stderr warning so operators and scripts can detect degraded recall.
          defaultRuntime.error(
            `Memory index WARNING (${agentId}): chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(vectorLoadErr)}. Vector recall degraded.`,
          );
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
        process.exitCode = 1;
      }
    },
  });
}
export async function runMemorySearch(
  query: string,
  opts: MemorySearchCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory search",
    options: opts,
    requiresMemorySlot: true,
    purpose: "cli",
    inspectSources: true,
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const result = await searchMemoryForCli({
        manager,
        cfg,
        agentId,
        query,
        maxResults: opts.maxResults,
        minScore: opts.minScore,
      });
      renderMemorySearch(result, opts.json);
    },
  });
}

export async function runMemoryForget(opts: MemoryForgetCommandOptions) {
  try {
    const cfg = getRuntimeConfig({ skipPluginValidation: true });
    const agentId = resolveMemoryAgent(cfg, opts.agent);
    const slotOwner = resolveForeignMemorySlotOwner(cfg);
    if (slotOwner) {
      emitMemoryCoreSidecarNotice(slotOwner, { json: Boolean(opts.json) });
    }
    const report = await forgetMemoryEntries({
      cfg,
      agentId,
      sessionIds: opts.session,
      hookSources: opts.hookSource,
      participants: opts.participant,
      since: opts.since,
      dryRun: Boolean(opts.dryRun),
    });
    if (opts.json) {
      defaultRuntime.writeJson(report);
      return;
    }
    const lines = [
      `${heading(report.dryRun ? "Memory Deletion Preview" : "Memory Deletion")} ${muted(`(${agentId})`)}`,
      `${muted("Source sessions:")} ${report.sessionIds.length}`,
      `${muted("Source transcripts retained:")} ${report.sessionIds.length}`,
      `${muted("Deleted entries:")} ${report.entryKeys.length}`,
      `${muted("Mixed-lineage entries deleted whole:")} ${report.mixedLineageEntryKeys.length}`,
      `${muted("Entries without targetable provenance:")} ${report.untargetableEntryKeys.length}`,
      `${muted("Curated writes retained:")} ${report.curatedWrites.length}`,
      `${muted("Memory artifacts:")} ${report.artifacts.memoryFiles} files, ${report.artifacts.memoryEntries} entries, ${report.artifacts.memoryLines} quoted lines`,
      `${muted("Session corpus:")} ${report.artifacts.sessionCorpusFiles} files, ${report.artifacts.sessionCorpusLines} lines`,
      `${muted("Index artifacts:")} ${report.artifacts.indexChunks} chunks, ${report.artifacts.indexSources} sources, ${report.artifacts.ftsRows} full-text rows, ${report.artifacts.vectorRows} vector rows, ${report.artifacts.embeddingCacheRows} cached embeddings`,
      `${muted("Plugin state:")} ${report.artifacts.shortTermEntries} short-term entries, ${report.artifacts.seenHashScopes} seen-hash scopes, ${report.artifacts.backups} backups`,
      `${muted("Origin rows:")} ${report.artifacts.originRows}`,
    ];
    if (report.sessionIds.length > 0) {
      lines.push(`${muted("Session IDs:")} ${report.sessionIds.join(", ")}`);
    }
    for (const session of report.sessionResolutions) {
      lines.push(`${muted("Session resolution:")} ${session.sessionId} (${session.source})`);
    }
    for (const match of report.participantMatches) {
      lines.push(
        `${muted("Raw participant selector:")} ${match.actorId}: ${match.identities.map((identity) => JSON.stringify(identity)).join(", ") || "no live match"}. Matches select whole sessions across identity namespaces.`,
      );
    }
    if (report.mixedLineageEntryKeys.length > 0) {
      lines.push(
        `${muted("Mixed-lineage entry keys:")} ${report.mixedLineageEntryKeys.join(", ")}`,
      );
    }
    if (report.untargetableEntryKeys.length > 0) {
      lines.push(`${muted("Untargetable entry keys:")} ${report.untargetableEntryKeys.join(", ")}`);
    }
    for (const curatedWrite of report.curatedWrites) {
      lines.push(
        `${muted("Curated write retained:")} ${curatedWrite.relativePath} (${new Date(curatedWrite.observedAt).toISOString()})`,
      );
    }
    for (const refusal of report.refusals) {
      lines.push(warn(`Refused: ${refusal}`));
    }
    if (report.dryRun) {
      lines.push(muted("Dry run: no memory files, index rows, or plugin state were changed."));
    }
    defaultRuntime.log(lines.join("\n"));
  } catch (error) {
    throw new Error(`Memory forget failed: ${formatErrorMessage(error)}`, { cause: error });
  }
}
