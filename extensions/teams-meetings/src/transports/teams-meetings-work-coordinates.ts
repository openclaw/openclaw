// Self-contained so Node and the serialized browser parser enforce the same grammar.
export function teamsWorkMeetingThread(coordinates: string[]): string | undefined {
  if (coordinates.length !== 1) {
    return undefined;
  }
  const encoded = coordinates[0];
  if (!encoded || encoded.length > 16_384 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) {
    return undefined;
  }
  try {
    const json = atob(encoded);
    if (btoa(json).replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      return undefined;
    }
    const decoded: unknown = JSON.parse(json);
    // The observed work coordinates are a flat string-valued object. Reject duplicate
    // JSON keys (including escaped spellings), which JSON.parse otherwise overwrites.
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return undefined;
    }
    if (Object.values(decoded).some((value) => typeof value !== "string")) {
      return undefined;
    }
    // Validate the raw shape too: JSON.parse can discard a nested value when a
    // later duplicate key overwrites it, breaking key/value token alternation.
    const stringLiteral = /"(?:\\.|[^"\\])*"/g;
    const shape = json.replace(stringLiteral, '""');
    if (!/^\s*\{\s*(?:""\s*:\s*""\s*(?:,\s*""\s*:\s*""\s*)*)?\}\s*$/.test(shape)) {
      return undefined;
    }
    const tokens = json.match(stringLiteral) ?? [];
    const keys = new Set<string>();
    for (const [index, token] of tokens.entries()) {
      if (index % 2 !== 0) {
        continue;
      }
      const key: string = JSON.parse(token);
      if (keys.has(key)) {
        return undefined;
      }
      keys.add(key);
    }
    if (!keys.has("conversationId")) {
      return undefined;
    }
    const thread: unknown = Reflect.get(decoded, "conversationId");
    return typeof thread === "string" &&
      /^19:[^/\s]+@thread\.(?:v2|tacv2)$/i.test(thread) &&
      !Array.from(thread).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
      ? thread
      : undefined;
  } catch {
    return undefined;
  }
}
