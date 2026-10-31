export type CodexCatalogResponseRoute = { id: number; kind: "list" | "thread" };
export type CodexCatalogDecodeRoute = CodexCatalogResponseRoute | "unresolved";

export function codexCatalogResponseRoute(
  id: number | string,
): CodexCatalogResponseRoute | undefined {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 2 ** 52
    ? { id, kind: id % 2 === 1 ? "list" : "thread" }
    : undefined;
}

/** Read bounded envelope keys and IDs; skip native payload strings as bytes. */
export function readCodexCatalogDecodeRoute(line: Buffer): CodexCatalogDecodeRoute | undefined {
  let depth = 0;
  let route: CodexCatalogResponseRoute | undefined;
  let response = false;
  for (let index = 0; index < line.length; index++) {
    const byte = line[index];
    if (byte === 123 || byte === 91) {
      depth++;
    } else if (byte === 125 || byte === 93) {
      depth--;
    } else if (byte === 34) {
      const start = index;
      for (;;) {
        index = line.indexOf(34, index + 1);
        if (index < 0) {
          // Keep malformed-payload parsing and diagnostics off the main thread.
          return "unresolved";
        }
        let slash = index - 1;
        while (line[slash] === 92) {
          slash--;
        }
        if ((index - slash) % 2 === 1) {
          break;
        }
      }
      if (depth !== 1 || index - start > 64) {
        continue;
      }
      let colon = index + 1;
      while (line[colon] === 32 || line[colon] === 9 || line[colon] === 13) {
        colon++;
      }
      if (line[colon] !== 58) {
        continue;
      }
      const token = line.toString("utf8", start, index + 1);
      let key: unknown = token.slice(1, -1);
      if (token.includes("\\")) {
        try {
          key = JSON.parse(token);
        } catch {
          return "unresolved";
        }
      }
      if (key === "method") {
        return undefined;
      }
      if (key === "result" || key === "error") {
        response = true;
        if (route) {
          return route;
        }
      }
      if (key !== "id") {
        continue;
      }
      const match = /^\s*:\s*(\d+)(?=\s*[,}])/u.exec(
        line.toString("utf8", index + 1, Math.min(index + 100, line.length)),
      );
      if (!match) {
        continue;
      }
      route = codexCatalogResponseRoute(Number(match[1]));
      if (!route || response) {
        return route;
      }
    }
  }
  return response || route ? "unresolved" : undefined;
}
