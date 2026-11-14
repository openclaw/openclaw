/** Parses the JSON-with-comments syntax accepted by root model catalogs. */
export function parseModelCatalogJson(input: string, generated = false): unknown {
  if (generated) {
    try {
      return JSON.parse(input) as unknown;
    } catch {
      // Imported generated catalogs retain the authored JSONC syntax below.
    }
  }
  const json = input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail) => tail ?? (match[0] === '"' ? match : ""),
    );
  return JSON.parse(json) as unknown;
}
