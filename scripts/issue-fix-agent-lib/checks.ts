export type CheckSnapshot = {
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
  readonly name: string;
  readonly status: string;
};

type RawCheckSnapshot = {
  readonly conclusion?: string | null;
  readonly detailsUrl?: string | null;
  readonly details_url?: string | null;
  readonly name?: string;
  readonly status?: string;
};

type CheckClassification =
  | {
      readonly failed: CheckSnapshot[];
      readonly kind: "failed";
      readonly pending: CheckSnapshot[];
    }
  | {
      readonly failed: CheckSnapshot[];
      readonly kind: "land_ready";
      readonly pending: CheckSnapshot[];
    }
  | {
      readonly failed: CheckSnapshot[];
      readonly kind: "pending";
      readonly pending: CheckSnapshot[];
    };

const routineCheckNames = new Set(["Auto response", "Labeler", "docs agents", "performance/stale"]);

function isRelevantCheck(snapshot: CheckSnapshot): boolean {
  return !routineCheckNames.has(snapshot.name);
}

function normalizeCheckName(raw: RawCheckSnapshot): string | null {
  const name = raw.name?.trim();
  return name ? name : null;
}

export function normalizePrCheckRollup(raw: readonly RawCheckSnapshot[]): CheckSnapshot[] {
  return raw.flatMap((entry) => {
    const name = normalizeCheckName(entry);
    if (!name) {
      return [];
    }
    return [
      {
        conclusion: entry.conclusion ?? null,
        detailsUrl: entry.detailsUrl ?? entry.details_url ?? null,
        name,
        status: entry.status ?? "UNKNOWN",
      },
    ];
  });
}

export function classifyCheckSnapshots(snapshots: readonly CheckSnapshot[]): CheckClassification {
  const relevant = snapshots.filter(isRelevantCheck);
  const failed = relevant.filter((snapshot) => {
    if (snapshot.status !== "COMPLETED") {
      return false;
    }
    return snapshot.conclusion !== "SUCCESS" && snapshot.conclusion !== "SKIPPED";
  });
  const pending = relevant.filter((snapshot) => snapshot.status !== "COMPLETED");
  if (failed.length > 0) {
    return { failed, kind: "failed", pending };
  }
  if (pending.length > 0) {
    return { failed, kind: "pending", pending };
  }
  return { failed, kind: "land_ready", pending };
}
