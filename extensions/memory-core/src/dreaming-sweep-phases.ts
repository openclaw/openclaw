import {
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendFailedDreamingEvent } from "./dreaming-events.js";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import type {
  DreamingPhasePreparation,
  DreamingPhaseRunParams,
  DreamingSweepParams,
  LightDreamingConfig,
  PreparedDreamNarrative,
  RemDreamingConfig,
} from "./dreaming-phase-types.js";
import {
  ingestDreamingPhaseSignals,
  prepareLightDreaming,
  prepareRemDreaming,
} from "./dreaming-phases.js";
import { formatErrorMessage } from "./dreaming-shared.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { resolveAdmissionPolicy } from "./session-ingestion.js";
import {
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
} from "./short-term-promotion.js";

export async function runDreamingSweepPhases(
  params: DreamingSweepParams,
): Promise<{ narratives: PreparedDreamNarrative[]; failed: boolean }> {
  // All phases in one sweep share the same observation and report timestamp.
  const sweepNowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const admissionPolicy = resolveAdmissionPolicy(params.pluginConfig);
  const narratives: PreparedDreamNarrative[] = [];
  let failed = false;
  async function runPhase<TConfig extends LightDreamingConfig | RemDreamingConfig>(
    phase: "light" | "rem",
    config: TConfig,
    prepare?: (params: DreamingPhaseRunParams<TConfig>) => Promise<DreamingPhasePreparation>,
  ): Promise<boolean> {
    if (!config.enabled || config.limit <= 0) {
      return true;
    }
    try {
      const phaseParams = { ...params, config, nowMs: sweepNowMs, admissionPolicy };
      if (!prepare) {
        await ingestDreamingPhaseSignals(phaseParams);
        return true;
      }
      // Keep source selection and report publication inside the forget boundary;
      // model work runs outside it and revalidates its inputs before publication.
      const data = await withMemoryWorkspaceLock(params.workspaceDir, async () => {
        const prepared = await prepare(phaseParams);
        const publication = { workspaceDir: params.workspaceDir, phase, nowMs: sweepNowMs };
        await writeDailyDreamingPhaseBlock({
          ...publication,
          workspaceFileMode: params.workspaceFileMode,
          bodyLines: prepared.bodyLines,
          hasContent: prepared.data !== undefined,
          timezone: config.timezone,
          storage: config.storage,
        });
        if (prepared.consideredKeys?.length) {
          await recordRemConsideredPhaseSignals({ ...publication, keys: prepared.consideredKeys });
        }
        await recordDreamingPhaseSignals({ ...publication, keys: prepared.keys });
        if (prepared.data && config.storage.mode !== "separate") {
          params.logger.info(prepared.logMessage);
        }
        return prepared.data;
      });
      if (data) {
        narratives.push({ data, timezone: config.timezone, model: config.execution?.model });
      }
      return true;
    } catch (err) {
      await appendFailedDreamingEvent({
        workspaceDir: params.workspaceDir,
        phase,
        error: formatErrorMessage(err),
        storageMode: config.storage.mode,
        nowMs: sweepNowMs,
        logger: params.logger,
      });
      params.logger.error(`memory-core: ${phase} dreaming failed: ${formatErrorMessage(err)}`);
      failed = true;
      return false;
    }
  }
  const light = resolveMemoryLightDreamingConfig(params);
  const rem = resolveMemoryRemDreamingConfig(params);
  // Both phases ingest before either selects inputs, so a later ingestion cannot
  // evict recall entries an earlier phase already staged for the diary.
  const lightIngested = await runPhase("light", light);
  const remIngested = lightIngested && (await runPhase("rem", rem));
  if (lightIngested && (await runPhase("light", light, prepareLightDreaming)) && remIngested) {
    await runPhase("rem", rem, prepareRemDreaming);
  }
  return { narratives, failed };
}
