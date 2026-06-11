import {
  applySnesJsonPatch,
  buildSnesReadiness,
  createDefaultSnesStudioProject,
  createFxpakExportManifest,
  createSnesAgentPatchProposal,
  createSnesAgentTaskBlueprints,
  createSnesBuildPipeline,
  createSnesSpc700ExportPlan,
  createSnesSaveManifest,
  generateSnesProjectFromPrompt,
  normalizeSnesStudioProject,
  stableProjectJson,
  type SnesAgentPatchProposal,
  type SnesBudgetMeter,
  type SnesJsonPatchOperation,
  type SnesStudioProject,
  type SnesPromptGenerationResult,
} from "@openclaw/snes-studio-core";

export const STANDALONE_STORAGE_KEY = "openclaw:snes-studio:standalone:project:v1";
export const STANDALONE_SNAPSHOT_KEY = `${STANDALONE_STORAGE_KEY}:snapshot`;

export type StandaloneStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StandaloneViewModel = ReturnType<typeof createStandaloneViewModel>;

export function isSnesStudioProject(value: unknown): value is SnesStudioProject {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SnesStudioProject>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.name === "string" &&
    Boolean(candidate.profile) &&
    Boolean(candidate.assets) &&
    Array.isArray(candidate.scenes) &&
    Boolean(candidate.export)
  );
}

export function parseSnesStudioProject(raw: string): SnesStudioProject {
  const parsed = JSON.parse(raw) as unknown;
  if (!isSnesStudioProject(parsed)) {
    throw new Error("File is not an SNES Studio project.");
  }
  return normalizeSnesStudioProject(parsed);
}

export function loadStandaloneProject(storage: StandaloneStorage | null): SnesStudioProject {
  const stored = storage?.getItem(STANDALONE_STORAGE_KEY);
  if (!stored) {
    return createDefaultSnesStudioProject();
  }
  try {
    return parseSnesStudioProject(stored);
  } catch {
    storage?.removeItem(STANDALONE_STORAGE_KEY);
    return createDefaultSnesStudioProject();
  }
}

export function saveStandaloneProject(
  storage: StandaloneStorage | null,
  project: SnesStudioProject,
): void {
  project.updatedAt = new Date().toISOString();
  storage?.setItem(STANDALONE_STORAGE_KEY, JSON.stringify(project));
}

export function saveStandaloneSnapshot(
  storage: StandaloneStorage | null,
  project: SnesStudioProject,
): string {
  const snapshot = stableProjectJson(project);
  storage?.setItem(STANDALONE_SNAPSHOT_KEY, snapshot);
  return snapshot;
}

export function createStandaloneViewModel(project: SnesStudioProject) {
  const readiness = buildSnesReadiness(project);
  return {
    agentTasks: createSnesAgentTaskBlueprints(project),
    manifest: createFxpakExportManifest(project),
    pipeline: createSnesBuildPipeline(project),
    projectJson: stableProjectJson(project),
    readiness,
    saveManifest: createSnesSaveManifest(project),
    spc700Plan: createSnesSpc700ExportPlan(project),
  };
}

export function meterPercent(meter: SnesBudgetMeter): number {
  return Math.max(0, Math.min(100, Math.round(meter.ratio * 100)));
}

export function generateStandaloneProjectFromPrompt(
  prompt: string,
  project: SnesStudioProject,
): SnesPromptGenerationResult {
  return generateSnesProjectFromPrompt(prompt, project);
}

export function createStandaloneAgentPatchProposal(
  prompt: string,
  project: SnesStudioProject,
): SnesAgentPatchProposal {
  return createSnesAgentPatchProposal(prompt, project, "openclaw-codex");
}

export function applyStandaloneAgentPatch(
  project: SnesStudioProject,
  operations: SnesJsonPatchOperation[],
): SnesStudioProject {
  return applySnesJsonPatch(project, operations);
}
