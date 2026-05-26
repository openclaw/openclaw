import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { B as MemoryProviderStatus, G as MemorySyncProgressUpdate } from "../../memory-state-CSqCMoFA.js";
import { t as MemoryEmbeddingProbeResult } from "../../memory-core-host-engine-storage-CpkTC98P.js";
import { i as ShortTermRecallEntry, t as PromotionCandidate } from "../../short-term-promotion-DjSK1tk-.js";
import { pt as resolveMemoryRemDreamingConfig, st as resolveMemoryDeepDreamingConfig } from "../../dreaming-B-5AZJCw.js";

//#region extensions/memory-core/src/dreaming-narrative.d.ts
declare function writeBackfillDiaryEntries(params: {
  workspaceDir: string;
  entries: Array<{
    isoDay: string;
    bodyLines: string[];
    sourcePath?: string;
  }>;
  timezone?: string;
}): Promise<{
  dreamsPath: string;
  written: number;
  replaced: number;
}>;
declare function removeBackfillDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{
  dreamsPath: string;
  removed: number;
}>;
declare function dedupeDreamDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{
  dreamsPath: string;
  removed: number;
  kept: number;
}>;
//#endregion
//#region extensions/memory-core/src/rem-evidence.d.ts
type GroundedRemPreviewItem = {
  text: string;
  refs: string[];
};
type GroundedRemCandidate = GroundedRemPreviewItem & {
  lean: "likely_durable" | "unclear" | "likely_situational";
};
type GroundedRemFilePreview = {
  path: string;
  facts: GroundedRemPreviewItem[];
  reflections: GroundedRemPreviewItem[];
  memoryImplications: GroundedRemPreviewItem[];
  candidates: GroundedRemCandidate[];
  renderedMarkdown: string;
};
type GroundedRemPreviewResult = {
  workspaceDir: string;
  scannedFiles: number;
  files: GroundedRemFilePreview[];
};
declare function previewGroundedRemMarkdown(params: {
  workspaceDir: string;
  inputPaths: string[];
}): Promise<GroundedRemPreviewResult>;
//#endregion
//#region extensions/memory-core/src/dreaming-phases.d.ts
declare function filterRecallEntriesWithinLookback(params: {
  entries: readonly ShortTermRecallEntry[];
  nowMs: number;
  lookbackDays: number;
}): ShortTermRecallEntry[];
type RemTruthSelection = {
  key: string;
  snippet: string;
  confidence: number;
  evidence: string;
};
type RemTruthCandidate = Omit<RemTruthSelection, "key">;
type RemDreamingPreview = {
  sourceEntryCount: number;
  reflections: string[];
  candidateTruths: RemTruthCandidate[];
  candidateKeys: string[];
  bodyLines: string[];
};
//#endregion
//#region extensions/memory-core/src/rem-harness.d.ts
type MemoryRemHarnessRemConfig = ReturnType<typeof resolveMemoryRemDreamingConfig>;
type MemoryRemHarnessDeepConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;
type PreviewRemHarnessOptions = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  grounded?: boolean;
  groundedInputPaths?: string[];
  groundedFileLimit?: number;
  includePromoted?: boolean;
  candidateLimit?: number;
  remPreviewLimit?: number;
  nowMs?: number;
};
type PreviewRemHarnessResult = {
  workspaceDir: string;
  nowMs: number;
  remConfig: MemoryRemHarnessRemConfig;
  deepConfig: MemoryRemHarnessDeepConfig;
  recallEntryCount: number;
  remSkipped: boolean;
  rem: RemDreamingPreview;
  groundedInputPaths: string[];
  grounded: GroundedRemPreviewResult | null;
  deep: {
    candidateLimit?: number;
    candidateCount: number;
    truncated: boolean;
    candidates: PromotionCandidate[];
  };
};
declare function previewRemHarness(params: PreviewRemHarnessOptions): Promise<PreviewRemHarnessResult>;
//#endregion
export { type MemoryEmbeddingProbeResult, type MemoryProviderStatus, type MemorySyncProgressUpdate, type OpenClawConfig, type PreviewRemHarnessOptions, type PreviewRemHarnessResult, dedupeDreamDiaryEntries, filterRecallEntriesWithinLookback, previewGroundedRemMarkdown, previewRemHarness, removeBackfillDiaryEntries, writeBackfillDiaryEntries };