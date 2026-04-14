export type QmdCollectionPatternFlag = "--glob" | "--mask";

export function resolveQmdCollectionPatternFlags(
  preferredFlag: QmdCollectionPatternFlag | null,
): QmdCollectionPatternFlag[] {
  // QMD 2.1.0 still parses collection-add patterns through the legacy `--mask`
  // option. Prefer it first until we can prove a given binary actually honors
  // `--glob` for `qmd collection add`.
  return preferredFlag === "--glob" ? ["--glob", "--mask"] : ["--mask", "--glob"];
}
