const LEGACY_CONTENT_INVENTORY_COMPAT_MIN = { year: 2026, month: 1, day: 29 };
const LEGACY_CONTENT_INVENTORY_COMPAT_MAX = { year: 2026, month: 6, day: 6 };

// These tagged package versions predate content-inventory packaging. Keep the
// list exact so later releases with the same calendar version must include it.
const LEGACY_CONTENT_INVENTORY_TAGGED_VERSIONS = new Set([
  "2026.6.7-alpha.1",
  "2026.6.7-alpha.2",
  "2026.6.7-alpha.3",
  "2026.6.7-alpha.4",
  "2026.6.7-alpha.5",
  "2026.6.7-alpha.6",
  "2026.6.7-beta.1",
  "2026.6.8-alpha.1",
  "2026.6.8-alpha.2",
  "2026.6.8-beta.1",
  "2026.6.8-beta.2",
  "2026.6.8",
  "2026.6.9-alpha.1",
  "2026.6.9-alpha.2",
  "2026.6.9-alpha.3",
  "2026.6.9-alpha.4",
  "2026.6.9-alpha.5",
  "2026.6.9-beta.1",
  "2026.6.9",
  "2026.6.10-alpha.1",
  "2026.6.10-alpha.2",
  "2026.6.10-beta.1",
  "2026.6.10-beta.2",
  "2026.6.10",
  "2026.6.11-beta.1",
  "2026.6.11-beta.2",
  "2026.6.11",
  "2026.6.15-alpha.1",
  "2026.7.1-beta.1",
  "2026.7.1-beta.2",
  "2026.7.1-beta.4",
  "2026.7.1-beta.5",
]);

function parseCalver(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/u.exec(version);
  if (!match) {
    return null;
  }
  const parsed = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (
    date.getUTCFullYear() !== parsed.year ||
    date.getUTCMonth() !== parsed.month - 1 ||
    date.getUTCDate() !== parsed.day
  ) {
    return null;
  }
  return parsed;
}

function compareCalver(left, right) {
  for (const key of ["year", "month", "day"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

export function isLegacyContentInventoryCompatVersion(version) {
  const normalized = typeof version === "string" ? version.trim() : "";
  if (LEGACY_CONTENT_INVENTORY_TAGGED_VERSIONS.has(normalized)) {
    return true;
  }
  const parsed = parseCalver(normalized);
  return parsed
    ? compareCalver(parsed, LEGACY_CONTENT_INVENTORY_COMPAT_MIN) >= 0 &&
        compareCalver(parsed, LEGACY_CONTENT_INVENTORY_COMPAT_MAX) <= 0
    : false;
}
