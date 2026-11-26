// Snapshots script supports OpenClaw repository automation.
import { die, run } from "./host-command.ts";
import type { Mode, SnapshotInfo } from "./types.ts";

const SNAPSHOT_LIST_TIMEOUT_MS = 120_000;
export const SKIP_SNAPSHOT_RESTORE_ENV = "OPENCLAW_PARALLELS_SKIP_SNAPSHOT_RESTORE";

export function shouldSkipSnapshotRestore(): boolean {
  return /^(1|true|yes|on)$/iu.test(process.env[SKIP_SNAPSHOT_RESTORE_ENV] ?? "");
}

export function validateSnapshotRestoreMode(mode: Mode, platform: string): void {
  if (!shouldSkipSnapshotRestore() || mode !== "both") {
    return;
  }
  die(
    `${SKIP_SNAPSHOT_RESTORE_ENV}=1 requires --mode fresh or --mode upgrade for ${platform}; --mode both would reuse the same mutated guest for both lanes`,
  );
}

export function currentRunningSnapshotInfo(vmName: string): SnapshotInfo {
  return {
    id: "current-running-vm",
    name: `current running ${vmName}`,
    state: "running",
  };
}

export function resolveSnapshot(vmName: string, hint: string): SnapshotInfo {
  const output = run("prlctl", ["snapshot-list", vmName, "--json"], {
    timeoutMs: SNAPSHOT_LIST_TIMEOUT_MS,
  }).stdout;
  if (!output.trim()) {
    die(
      `prlctl snapshot-list ${vmName} --json returned no snapshots; create/restore a snapshot or set ${SKIP_SNAPSHOT_RESTORE_ENV}=1 for an already-started guest`,
    );
  }
  const payload = JSON.parse(output) as Record<
    string,
    { date?: string; name?: string; state?: string }
  >;
  let best: SnapshotInfo | null = null;
  let bestScore = -1;
  let bestDate = "";
  const aliases = (name: string): string[] => {
    const values = [name];
    for (const pattern of [/^(.*)-poweroff$/, /^(.*)-poweroff-\d{4}-\d{2}-\d{2}$/]) {
      const match = name.match(pattern);
      if (match?.[1]) {
        values.push(match[1]);
      }
    }
    return values.flatMap((value) => {
      const withoutLatest = value.replace(/\s+latest$/u, "").trim();
      return withoutLatest && withoutLatest !== value ? [value, withoutLatest] : [value];
    });
  };
  const normalizedHint = hint.trim().toLowerCase();
  const normalizedHints = [normalizedHint, normalizedHint.replace(/\s+latest$/u, "").trim()].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  for (const [id, meta] of Object.entries(payload)) {
    const name = (meta.name ?? "").trim();
    if (!name) {
      continue;
    }
    let score = 0;
    for (const hintAlias of normalizedHints) {
      for (const alias of aliases(name.toLowerCase())) {
        if (alias === hintAlias) {
          score = Math.max(score, 10);
        } else if (hintAlias && alias.includes(hintAlias)) {
          score = Math.max(score, 5 + hintAlias.length / Math.max(alias.length, 1));
        } else {
          score = Math.max(score, stringSimilarity(hintAlias, alias));
        }
      }
    }
    if ((meta.state ?? "").toLowerCase() === "poweroff") {
      score += 0.5;
    }
    const date = (meta.date ?? "").trim();
    // Parallels lists snapshots oldest-first. Prefer the newest reusable baseline when fuzzy
    // names tie, while preserving the original order when date metadata is unavailable.
    if (score > bestScore || (score === bestScore && bestDate && date && date > bestDate)) {
      bestScore = score;
      bestDate = date;
      best = { id, name, state: (meta.state ?? "").trim() };
    }
  }
  if (!best) {
    die("no snapshot matched");
  }
  return best;
}

function stringSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(
        above + 1,
        row[j - 1]! + 1,
        diagonal + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length, 1);
}
