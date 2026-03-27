import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { MissionRecord, SubtaskRecord } from "./subagent-mission.js";

type SerializedSubtaskRecord = SubtaskRecord;

type SerializedMissionRecord = Omit<MissionRecord, "subtasks"> & {
  subtasks: Record<string, SerializedSubtaskRecord>;
};

type PersistedMissionStore = {
  version: 1;
  missions: Record<string, SerializedMissionRecord>;
};

export function resolveMissionStorePath(): string {
  return path.join(STATE_DIR, "subagents", "missions.json");
}

export function loadMissionsFromDisk(): Map<string, MissionRecord> {
  const pathname = resolveMissionStorePath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedMissionStore>;
  if (record.version !== 1) {
    return new Map();
  }
  const missionsRaw = record.missions;
  if (!missionsRaw || typeof missionsRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, MissionRecord>();
  for (const [missionId, entry] of Object.entries(missionsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (!entry.missionId || typeof entry.missionId !== "string") {
      continue;
    }
    // Convert subtasks object back to Map
    const subtaskMap = new Map<string, SubtaskRecord>();
    if (entry.subtasks && typeof entry.subtasks === "object") {
      for (const [id, subtask] of Object.entries(entry.subtasks)) {
        if (subtask && typeof subtask === "object") {
          subtaskMap.set(id, subtask);
        }
      }
    }
    out.set(missionId, {
      ...entry,
      subtasks: subtaskMap,
    } as MissionRecord);
  }
  return out;
}

export function saveMissionsToDisk(missions: Map<string, MissionRecord>) {
  const pathname = resolveMissionStorePath();
  const serialized: Record<string, SerializedMissionRecord> = {};
  for (const [missionId, mission] of missions.entries()) {
    const subtasks: Record<string, SerializedSubtaskRecord> = {};
    for (const [id, subtask] of mission.subtasks.entries()) {
      subtasks[id] = subtask;
    }
    serialized[missionId] = {
      ...mission,
      subtasks,
    };
  }
  const out: PersistedMissionStore = {
    version: 1,
    missions: serialized,
  };
  saveJsonFile(pathname, out);
}
