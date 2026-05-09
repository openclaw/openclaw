import {
  isCompactionCheckpointTranscriptFileName,
  isTrajectoryRuntimeArtifactName,
} from "../../../../src/config/sessions/artifacts.js";

export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return false;
  }
  return true;
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isUsageCountedSessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  return null;
}
