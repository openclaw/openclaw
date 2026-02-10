import fs from "node:fs";
import path from "node:path";

export type AffectionToday = {
  date: string; // YYYY-MM-DD
  affGain: number;
};

export type AffectionStateV3b = {
  version: "v3b";
  // a simple "overall" dial; label is derived from this
  aff: number;
  label: string;

  // sub-dials
  closeness: number;
  trust: number;
  reliabilityTrust: number;
  irritation: number;

  cooldownUntil?: string | null;
  today: AffectionToday;
  lastMessageAt: string;
};

export type AffectionAuditEvent = {
  ts: string;
  action: "init" | "touch" | "sorry";
  note?: string;
  deltas?: Partial<Record<keyof Pick<AffectionStateV3b, "aff" | "closeness" | "trust" | "reliabilityTrust" | "irritation">, number>>;
};

function clamp01(n: number) {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isoNow() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export function resolveAffectionPaths(workspace: string) {
  const dir = path.join(workspace, "affection");
  return {
    dir,
    statePath: path.join(dir, "state.json"),
    auditPath: path.join(dir, "audit.jsonl"),
  };
}

export function labelForAff(aff: number): string {
  if (aff <= -5) return "hostile";
  if (aff <= -1) return "irritable";
  if (aff <= 2) return "neutral";
  if (aff <= 6) return "fond";
  if (aff <= 12) return "attached";
  return "soft";
}

export async function appendAudit(workspace: string, ev: AffectionAuditEvent) {
  const { dir, auditPath } = resolveAffectionPaths(workspace);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(auditPath, `${JSON.stringify(ev)}\n`, "utf8");
}

export async function loadOrInitState(workspace: string): Promise<AffectionStateV3b> {
  const { dir, statePath } = resolveAffectionPaths(workspace);
  await fs.promises.mkdir(dir, { recursive: true });

  try {
    const raw = await fs.promises.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AffectionStateV3b>;

    const date = todayDate();
    const today: AffectionToday =
      parsed.today?.date === date
        ? { date, affGain: Number(parsed.today?.affGain ?? 0) }
        : { date, affGain: 0 };

    const aff = Number(parsed.aff ?? 0);
    const state: AffectionStateV3b = {
      version: "v3b",
      aff,
      label: typeof parsed.label === "string" ? parsed.label : labelForAff(aff),
      closeness: clamp01(Number(parsed.closeness ?? 0.35)),
      trust: clamp01(Number(parsed.trust ?? 0.4)),
      reliabilityTrust: clamp01(Number(parsed.reliabilityTrust ?? 0.5)),
      irritation: clamp01(Number(parsed.irritation ?? 0.1)),
      cooldownUntil: parsed.cooldownUntil ?? null,
      today,
      lastMessageAt: typeof parsed.lastMessageAt === "string" ? parsed.lastMessageAt : isoNow(),
    };

    // keep derived label consistent
    state.label = labelForAff(state.aff);

    return state;
  } catch {
    const state: AffectionStateV3b = {
      version: "v3b",
      aff: 0,
      label: labelForAff(0),
      closeness: 0.35,
      trust: 0.4,
      reliabilityTrust: 0.5,
      irritation: 0.1,
      cooldownUntil: null,
      today: { date: todayDate(), affGain: 0 },
      lastMessageAt: isoNow(),
    };

    await saveState(workspace, state);
    await appendAudit(workspace, { ts: isoNow(), action: "init" });
    return state;
  }
}

export async function saveState(workspace: string, state: AffectionStateV3b) {
  const { statePath } = resolveAffectionPaths(workspace);
  // write atomically-ish
  const tmp = `${statePath}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.promises.rename(tmp, statePath);
}

export async function touch(workspace: string, note?: string) {
  const state = await loadOrInitState(workspace);
  state.lastMessageAt = isoNow();
  await saveState(workspace, state);
  await appendAudit(workspace, { ts: isoNow(), action: "touch", note });
  return state;
}

export async function sorry(workspace: string, note?: string) {
  const state = await loadOrInitState(workspace);

  const before = { ...state };

  // deterministic "self-repair" nudge
  state.irritation = clamp01(state.irritation - 0.15);
  state.reliabilityTrust = clamp01(state.reliabilityTrust + 0.12);
  state.trust = clamp01(state.trust + 0.05);
  state.aff = Math.min(999, state.aff + 1);
  state.label = labelForAff(state.aff);
  state.lastMessageAt = isoNow();

  await saveState(workspace, state);
  await appendAudit(workspace, {
    ts: isoNow(),
    action: "sorry",
    note,
    deltas: {
      irritation: state.irritation - before.irritation,
      reliabilityTrust: state.reliabilityTrust - before.reliabilityTrust,
      trust: state.trust - before.trust,
      aff: state.aff - before.aff,
    },
  });

  return state;
}

export function formatAffStatus(state: AffectionStateV3b) {
  return (
    `Affection (V3b — deterministic)\n\n` +
    `- label: ${state.label} | aff: ${state.aff}\n` +
    `- closeness: ${state.closeness.toFixed(3)}\n` +
    `- trust: ${state.trust.toFixed(3)}\n` +
    `- reliabilityTrust: ${state.reliabilityTrust.toFixed(3)}\n` +
    `- irritation: ${state.irritation.toFixed(3)}\n` +
    `- cooldown: ${state.cooldownUntil ? state.cooldownUntil : "none"}\n` +
    `- today affGain: ${state.today?.affGain ?? 0}/12\n` +
    `- lastMessageAt: ${state.lastMessageAt}`
  );
}
