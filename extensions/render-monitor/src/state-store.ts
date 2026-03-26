import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { RenderMonitorState, StoredRenderIncident, RenderIncidentType } from "./types.js";

const STATE_REL_ROOT = path.join("plugins", "render-monitor");

const STATE_VERSION = 1;

function resolveStateDir(stateDir: string): string {
  return path.join(stateDir, STATE_REL_ROOT);
}

function resolveStatePath(stateDir: string): string {
  return path.join(resolveStateDir(stateDir), "state.json");
}

function stableFingerprint(input: unknown): string {
  const raw = JSON.stringify(input);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function resolveIncidentId(fingerprint: string): string {
  // Keep IDs short enough to fit in Telegram args safely.
  return fingerprint.slice(0, 16);
}

export function computeIncidentFingerprint(params: {
  serviceId: string;
  incidentType: RenderIncidentType;
  deployId?: string | null;
  healthState?: string | null;
  extra?: Record<string, unknown>;
}): { fingerprint: string; incidentId: string } {
  const fingerprint = stableFingerprint({
    serviceId: params.serviceId,
    incidentType: params.incidentType,
    deployId: params.deployId ?? null,
    healthState: params.healthState ?? null,
    extra: params.extra ?? null,
  });
  return { fingerprint, incidentId: resolveIncidentId(fingerprint) };
}

export async function loadRenderMonitorState(stateDir: string): Promise<RenderMonitorState> {
  const statePath = resolveStatePath(stateDir);
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RenderMonitorState>;
    if (parsed.version !== STATE_VERSION) {
      throw new Error("state version mismatch");
    }
    if (!parsed.incidentsById || !parsed.incidentIdByFingerprint) {
      throw new Error("state missing required fields");
    }
    return {
      version: STATE_VERSION,
      updatedAtMs: parsed.updatedAtMs ?? Date.now(),
      incidentsById: parsed.incidentsById,
      incidentIdByFingerprint: parsed.incidentIdByFingerprint,
      serviceErrorStreakByServiceId: parsed.serviceErrorStreakByServiceId ?? {},
    };
  } catch {
    return {
      version: STATE_VERSION,
      updatedAtMs: Date.now(),
      incidentsById: {},
      incidentIdByFingerprint: {},
      serviceErrorStreakByServiceId: {},
    };
  }
}

export async function saveRenderMonitorState(
  stateDir: string,
  next: RenderMonitorState,
): Promise<void> {
  const stateRoot = resolveStateDir(stateDir);
  await fs.mkdir(stateRoot, { recursive: true });
  const statePath = resolveStatePath(stateDir);
  await fs.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function upsertIncident(params: {
  state: RenderMonitorState;
  incident: StoredRenderIncident;
}): RenderMonitorState {
  const { state, incident } = params;
  const existing = state.incidentsById[incident.id];
  const nextIncident: StoredRenderIncident = existing
    ? {
        ...existing,
        lastDetectedAtMs: Math.max(existing.lastDetectedAtMs, incident.lastDetectedAtMs),
        summary: incident.summary || existing.summary,
        details: incident.details ?? existing.details,
      }
    : incident;

  return {
    ...state,
    updatedAtMs: Date.now(),
    incidentsById: {
      ...state.incidentsById,
      [incident.id]: nextIncident,
    },
    incidentIdByFingerprint: {
      ...state.incidentIdByFingerprint,
      [incident.fingerprint]: incident.id,
    },
  };
}

export function ackIncident(params: {
  state: RenderMonitorState;
  incidentId: string;
  acknowledgedAtMs?: number;
}): { state: RenderMonitorState; changed: boolean } {
  const { state, incidentId } = params;
  const existing = state.incidentsById[incidentId];
  if (!existing) {
    return { state, changed: false };
  }
  if (existing.acknowledgedAtMs != null) {
    return { state, changed: false };
  }
  const next = {
    ...existing,
    acknowledgedAtMs: params.acknowledgedAtMs ?? Date.now(),
  };
  return {
    state: {
      ...state,
      updatedAtMs: Date.now(),
      incidentsById: { ...state.incidentsById, [incidentId]: next },
    },
    changed: true,
  };
}

export function markIncidentAlerted(params: {
  state: RenderMonitorState;
  incidentId: string;
  alertedAtMs?: number;
}): RenderMonitorState {
  const existing = params.state.incidentsById[params.incidentId];
  if (!existing) {
    return params.state;
  }
  const next = {
    ...existing,
    lastAlertedAtMs: params.alertedAtMs ?? Date.now(),
  };
  return {
    ...params.state,
    updatedAtMs: Date.now(),
    incidentsById: { ...params.state.incidentsById, [params.incidentId]: next },
  };
}

export function resolveIncidentById(
  state: RenderMonitorState,
  incidentId: string,
): StoredRenderIncident | null {
  return state.incidentsById[incidentId] ?? null;
}

export function resolveIncidentByFingerprint(
  state: RenderMonitorState,
  fingerprint: string,
): StoredRenderIncident | null {
  const incidentId = state.incidentIdByFingerprint[fingerprint];
  if (!incidentId) {
    return null;
  }
  return state.incidentsById[incidentId] ?? null;
}

export function shouldDedupeIncident(params: {
  state: RenderMonitorState;
  incident: { incidentId: string; fingerprint: string; createdAtMs: number };
  nowMs: number;
  dedupeTtlMinutes: number;
}): boolean {
  const existing = resolveIncidentByFingerprint(params.state, params.incident.fingerprint);
  if (!existing) {
    return false;
  }
  // If already alerted recently, suppress. Acknowledged incidents are still
  // recorded, but we do not spam.
  const ttlMs = params.dedupeTtlMinutes * 60_000;
  const lastAlertedAtMs = existing.lastAlertedAtMs ?? existing.acknowledgedAtMs ?? 0;
  if (!lastAlertedAtMs) {
    return false;
  }
  return params.nowMs - lastAlertedAtMs < ttlMs;
}

export function upsertInvestigation(params: {
  state: RenderMonitorState;
  incidentId: string;
  investigation: {
    runId?: string;
    sessionKey: string;
    startedAtMs: number;
  };
}): RenderMonitorState {
  const existing = params.state.incidentsById[params.incidentId];
  if (!existing) {
    return params.state;
  }
  const nextInvestigation = {
    ...(existing.lastInvestigation ?? null),
    runId: params.investigation.runId ?? existing.lastInvestigation?.runId,
    sessionKey: params.investigation.sessionKey,
    startedAtMs: params.investigation.startedAtMs,
    finishedAtMs: existing.lastInvestigation?.finishedAtMs ?? null,
    proposal: existing.lastInvestigation?.proposal ?? undefined,
  };
  const next: StoredRenderIncident = { ...existing, lastInvestigation: nextInvestigation };
  return {
    ...params.state,
    updatedAtMs: Date.now(),
    incidentsById: { ...params.state.incidentsById, [params.incidentId]: next },
  };
}

export function updateInvestigationProposal(params: {
  state: RenderMonitorState;
  incidentId: string;
  proposal: unknown;
  finishedAtMs?: number;
}): RenderMonitorState {
  const existing = params.state.incidentsById[params.incidentId];
  if (!existing || !existing.lastInvestigation) {
    return params.state;
  }
  const nextInvestigation = {
    ...existing.lastInvestigation,
    proposal: params.proposal,
    finishedAtMs: params.finishedAtMs ?? Date.now(),
  };
  const next: StoredRenderIncident = { ...existing, lastInvestigation: nextInvestigation };
  return {
    ...params.state,
    updatedAtMs: Date.now(),
    incidentsById: { ...params.state.incidentsById, [params.incidentId]: next },
  };
}

