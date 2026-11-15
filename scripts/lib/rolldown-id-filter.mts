// Rolldown evaluates hook filters natively, so a filtered hook never sees unrelated modules.

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Rolldown normalizes module ids to forward slashes before matching filters, also on Windows.
const toFilterPath = (value: string) => escapeRegExp(value.replaceAll("\\", "/"));

/** Matches exactly these module ids, which Rolldown reports as resolved real paths. */
export function exactIdFilter(...ids: string[]) {
  return { id: new RegExp(`^(?:${ids.map(toFilterPath).join("|")})$`, "u") };
}

/** Matches module ids under directory whose basename matches basename. */
export function directoryIdFilter(directory: string, basename: RegExp) {
  return { id: new RegExp(`^${toFilterPath(directory)}/${basename.source}$`, "u") };
}
