import fs from "node:fs/promises";
import path from "node:path";
import type {
  SpecApprovalRecord,
  SpecCenterState,
  SpecOptimizationRecord,
  SpecRecord,
  SpecRunRecord,
  SpecScheduleRecord,
} from "./types.js";

const STATE_FILE = "spec-center.json";

export type SpecCenterStore = {
  load: () => Promise<SpecCenterState>;
  save: (state: SpecCenterState) => Promise<void>;
  upsertSpec: (spec: SpecRecord) => Promise<SpecCenterState>;
  appendRun: (run: SpecRunRecord) => Promise<SpecCenterState>;
  upsertSchedule: (schedule: SpecScheduleRecord) => Promise<SpecCenterState>;
  updateScheduleStatus: (
    specId: string,
    status: SpecScheduleRecord["status"],
  ) => Promise<SpecCenterState>;
  appendOptimization: (optimization: SpecOptimizationRecord) => Promise<SpecCenterState>;
  updateOptimization: (
    optimizationId: string,
    patch: Partial<SpecOptimizationRecord>,
  ) => Promise<SpecCenterState>;
  appendApproval: (approval: SpecApprovalRecord) => Promise<SpecCenterState>;
};

export function createEmptyState(): SpecCenterState {
  return {
    version: 1,
    approvers: [],
    specs: {},
    runs: [],
    schedules: {},
    optimizations: [],
    approvals: [],
  };
}

export function resolveSpecCenterStatePath(stateDir: string): string {
  return path.join(stateDir, "spec-center", STATE_FILE);
}

export function createSpecCenterStore(params: { stateDir: string }): SpecCenterStore {
  const statePath = resolveSpecCenterStatePath(params.stateDir);

  async function load(): Promise<SpecCenterState> {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as unknown;
      return normalizeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyState();
      }
      throw error;
    }
  }

  async function save(state: SpecCenterState): Promise<void> {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, statePath);
  }

  return {
    load,
    save,
    async upsertSpec(spec) {
      const state = await load();
      const next: SpecCenterState = {
        ...state,
        specs: {
          ...state.specs,
          [spec.id]: spec,
        },
      };
      await save(next);
      return next;
    },
    async appendRun(run) {
      const state = await load();
      const next: SpecCenterState = {
        ...state,
        runs: [run, ...state.runs].slice(0, 100),
      };
      await save(next);
      return next;
    },
    async upsertSchedule(schedule) {
      const state = await load();
      const next: SpecCenterState = {
        ...state,
        schedules: {
          ...state.schedules,
          [schedule.specId]: schedule,
        },
      };
      await save(next);
      return next;
    },
    async updateScheduleStatus(specId, status) {
      const state = await load();
      const existing = state.schedules[specId];
      if (!existing) {
        throw new Error(`No schedule found for spec: ${specId}`);
      }
      const next: SpecCenterState = {
        ...state,
        schedules: {
          ...state.schedules,
          [specId]: {
            ...existing,
            status,
            updatedAt: new Date().toISOString(),
          },
        },
      };
      await save(next);
      return next;
    },
    async appendOptimization(optimization) {
      const state = await load();
      const next: SpecCenterState = {
        ...state,
        optimizations: [optimization, ...state.optimizations].slice(0, 100),
      };
      await save(next);
      return next;
    },
    async updateOptimization(optimizationId, patch) {
      const state = await load();
      let found = false;
      const optimizations = state.optimizations.map((optimization) => {
        if (optimization.optimizationId !== optimizationId) {
          return optimization;
        }
        found = true;
        return {
          ...optimization,
          ...patch,
        };
      });
      if (!found) {
        throw new Error(`Spec optimization not found: ${optimizationId}`);
      }
      const next: SpecCenterState = {
        ...state,
        optimizations,
      };
      await save(next);
      return next;
    },
    async appendApproval(approval) {
      const state = await load();
      const next: SpecCenterState = {
        ...state,
        approvals: [approval, ...state.approvals].slice(0, 100),
      };
      await save(next);
      return next;
    },
  };
}

function normalizeState(value: unknown): SpecCenterState {
  if (!isRecord(value)) {
    return createEmptyState();
  }
  const specs = isRecord(value.specs) ? (value.specs as Record<string, SpecRecord>) : {};
  const runs = Array.isArray(value.runs) ? (value.runs as SpecRunRecord[]) : [];
  const schedules = isRecord(value.schedules)
    ? (value.schedules as Record<string, SpecScheduleRecord>)
    : {};
  const optimizations = Array.isArray(value.optimizations)
    ? (value.optimizations as SpecOptimizationRecord[])
    : [];
  const approvals = Array.isArray(value.approvals) ? (value.approvals as SpecApprovalRecord[]) : [];
  return {
    version: 1,
    ...(typeof value.team === "string" ? { team: value.team } : {}),
    ...(typeof value.owner === "string" ? { owner: value.owner } : {}),
    approvers: Array.isArray(value.approvers)
      ? value.approvers.filter((entry): entry is string => typeof entry === "string")
      : [],
    specs,
    runs,
    schedules,
    optimizations,
    approvals,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
