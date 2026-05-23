/**
 * Dreaming Provider — memory-core implementation of the dreaming protocol.
 *
 * This file wraps memory-core's existing dreaming-phase and short-term-promotion
 * modules into a {@link MemoryPluginDreamingProvider} and registers it via the
 * plugin capability system so the dreaming runtime can discover it dynamically.
 *
 * Any alternative memory plugin can implement the same interface to opt into
 * the same dreaming lifecycle — light, deep, and REM consolidation phases.
 *
 * @see MemoryPluginDreamingProvider
 * @see registerMemoryCapability
 */

import type {
  MemoryPluginDreamingProvider,
  DreamingPromotionResult,
} from "openclaw/plugin-sdk/memory-state";
import { registerMemoryCapability } from "openclaw/plugin-sdk/memory-state";

/**
 * Build a {@link MemoryPluginDreamingProvider} backed by memory-core's
 * existing internal modules.
 *
 * All phase implementations are lazy-imported to avoid circular dependencies
 * at module load time: this factory is called during plugin registration but
 * the actual dreaming code loads on first phase invocation.
 */
export function createMemoryCoreDreamingProvider(): MemoryPluginDreamingProvider {
  return {
    /**
     * Light phase: scan daily memory files and recent session transcripts
     * for candidate material, write ingested recall entries and a light-sleep
     * dream diary entry.
     */
    runLightPhase: async (params) => {
      const { runDreamingSweepPhases } = await import("./dreaming-phases.js");
      await runDreamingSweepPhases({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg as Record<string, unknown>,
        logger: params.logger as any,
        nowMs: params.nowMs,
        detachNarratives: true,
      });
    },

    /**
     * Deep phase: rank short-term recall candidates, promote high-scorers
     * to MEMORY.md, write a dreaming report, and generate narrative.
     */
    runDeepPhase: async (params) => {
      const sweepNowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();

      const {
        repairShortTermPromotionArtifacts,
        rankShortTermPromotionCandidates,
        applyShortTermPromotions,
      } = await import("./short-term-promotion.js");

      // 1. Repair any stale lock or invalid entries
      const repairResult = await repairShortTermPromotionArtifacts({
        workspaceDir: params.workspaceDir,
        logger: params.logger as any,
      });
      if (repairResult.rewroteStore) {
        params.logger.info(
          `memory-core: repaired recall store for ${params.workspaceDir}`,
        );
      }

      // 2. Read recall store and rank candidates
      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir: params.workspaceDir,
        limit: params.limit,
        minScore: params.minScore,
        logger: params.logger as any,
        nowMs: sweepNowMs,
      });

      if (ranked.length === 0) {
        params.logger.debug("memory-core: no promotion candidates found");
        return { applied: 0, appliedCandidates: [], droppedDates: [] };
      }

      // 3. Promote the top candidates to MEMORY.md
      const applied = await applyShortTermPromotions({
        workspaceDir: params.workspaceDir,
        candidates: ranked,
        logger: params.logger as any,
      });

      params.logger.info(
        `memory-core: promoted ${applied.applied} candidate(s) in ${params.workspaceDir}` +
          (applied.droppedDates.length > 0
            ? ` (dropped ${applied.droppedDates.length} stale promotion sections)`
            : ""),
      );

      return applied;
    },

    /**
     * REM phase: run REM reflection analysis and write dream diary entry.
     */
    runRemPhase: async (params) => {
      const { runDreamingSweepPhases } = await import("./dreaming-phases.js");
      await runDreamingSweepPhases({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg as Record<string, unknown>,
        logger: params.logger as any,
        nowMs: params.nowMs,
        detachNarratives: true,
      });
    },
  };
}
