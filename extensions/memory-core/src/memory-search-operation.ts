import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemorySearchStaleness,
  readMemorySearchManagerStatus,
  type MemoryCliSearchParams,
  type MemoryCliSearchResult,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
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
    readRebuildWarning = captureMemoryRebuildNotice(await readMemorySearchManagerStatus(manager));
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
  const status = await readMemorySearchManagerStatus(manager);
  const staleness = resolveMemorySearchStaleness(status, agentId);
  let warning = [staleness?.warning, readRebuildWarning()].filter(Boolean).join(" ");
  const pluginConfig = resolvePluginConfigObject(cfg, "memory-core") ?? {};
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
    ).catch((error: unknown) => {
      warning = [warning, `Memory recall recording failed: ${formatErrorMessage(error)}`]
        .filter(Boolean)
        .join(" ");
    });
  }
  assertCurrent?.();
  return { results, ...staleness, ...(warning ? { warning } : {}) };
}
