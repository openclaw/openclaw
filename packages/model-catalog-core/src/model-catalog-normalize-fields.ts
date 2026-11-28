/** Copy each listed field whose normalized value is defined into `result`. */
export function normalizeCatalogFields<K extends string, V>(
  fields: readonly K[],
  normalize: (field: K) => V | undefined,
  result: Partial<Record<K, V>> = {},
): Partial<Record<K, V>> {
  for (const field of fields) {
    const value = normalize(field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}
