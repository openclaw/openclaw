/** Compare registry-issued category priorities, then downloads and canonical identity. */
export function comparePluginCatalogEntries(
  left: {
    id: string;
    catalog: { packageName?: string; downloads?: number; categoryRanks?: Record<string, number> };
  },
  right: {
    id: string;
    catalog: { packageName?: string; downloads?: number; categoryRanks?: Record<string, number> };
  },
  category?: string | null,
): number {
  if (category) {
    const leftRank = left.catalog.categoryRanks?.[category] ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.catalog.categoryRanks?.[category] ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
  }
  const downloads = (right.catalog.downloads ?? 0) - (left.catalog.downloads ?? 0);
  const leftIdentity = left.catalog.packageName ?? left.id;
  const rightIdentity = right.catalog.packageName ?? right.id;
  return downloads || (leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0);
}
