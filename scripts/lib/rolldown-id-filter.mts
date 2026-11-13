// Rolldown evaluates hook filters natively, so a filtered hook never sees unrelated modules.

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Matches exactly these module ids, which Rolldown reports as resolved real paths. */
export function exactIdFilter(...ids: string[]) {
  return { id: new RegExp(`^(?:${ids.map(escapeRegExp).join("|")})$`, "u") };
}

/** Matches module ids under directory whose basename matches basename. */
export function directoryIdFilter(directory: string, basename: RegExp) {
  return { id: new RegExp(`^${escapeRegExp(directory)}[\\\\/]${basename.source}$`, "u") };
}
