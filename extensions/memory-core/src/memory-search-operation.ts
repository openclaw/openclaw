import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemorySearchStaleness,
  type MemoryCliSearchParams,
  type MemoryCliSearchResult,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withMemoryMutationAuthority } from "./memory-mutation-authority.js";
import { captureMemoryRebuildNotice } from "./memory-rebuild-notice.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { recordShortTermRecalls } from "./short-term-promotion-record.js";

/** Shared CLI search semantics, independent of transport and terminal rendering. */
export async function searchMemoryForCli(
  params: MemoryCliSearchParams,
): Promise<MemoryCliSearchResult> {
  const { manager, cfg, agentId, query, assertCurrent } = params;
  assertCurrent?.();
  let readRebuildWarning: () => string | undefined = () => undefined;
  let results: MemorySearchResult[];
  try {
    readRebuildWarning = captureMemoryRebuildNotice(manager.status());
    results = await manager.search(query, {
      maxResults: params.maxResults,
      minScore: params.minScore,
      sessionKey: buildAgentSessionKey({
        agentId,
        channel: "cli",
        peer: { kind: "direct", id: "memory-search" },
        dmScope: "per-channel-peer",
      }),
    });
  } catch (error) {
    throw new Error(
      [`Memory search failed: ${formatErrorMessage(error)}`, readRebuildWarning()]
        .filter(Boolean)
        .join(" "),
      { cause: error },
    );
  }
  assertCurrent?.();
  const status = manager.status();
  const staleness = resolveMemorySearchStaleness(status, agentId);
  const warning = [staleness?.warning, readRebuildWarning()].filter(Boolean).join(" ");
  const pluginConfig = asNullableRecord(cfg.plugins?.entries?.["memory-core"]?.config) ?? {};
  if (resolveMemoryDreamingConfig({ cfg, pluginConfig }).enabled) {
    const dreaming = resolveMemoryDeepDreamingConfig({ cfg, pluginConfig });
    const record = () =>
      recordShortTermRecalls({
        workspaceDir: status.workspaceDir,
        query,
        results,
        timezone: dreaming.timezone,
      });
    const workspaceDir = status.workspaceDir?.trim();
    // Cleanup keeps its workspace lease even when the request's mutation authority closes.
    await (
      assertCurrent && workspaceDir
        ? withMemoryWorkspaceLock(workspaceDir, () =>
            withMemoryMutationAuthority(assertCurrent, record),
          )
        : record()
    ).catch(() => {});
  }
  assertCurrent?.();
  return { results, ...staleness, ...(warning ? { warning } : {}) };
}
