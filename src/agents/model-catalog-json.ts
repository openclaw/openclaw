/** Parses the JSON-with-comments syntax accepted by root model catalogs. */
export function parseModelCatalogJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Generated catalogs are strict JSON; only authored JSONC needs normalization.
    // Keep its final parse so malformed JSONC retains the normalized diagnostic.
  }
  const json = input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail) => tail ?? (match[0] === '"' ? match : ""),
    );
  return JSON.parse(json) as unknown;
}
