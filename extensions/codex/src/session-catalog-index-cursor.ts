import { createHash } from "node:crypto";
import {
  codexCatalogRowRecency,
  type CodexCatalogOrderKey,
} from "./session-catalog-index-order.js";
import { CatalogParamsError, readControlCursor } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogPageParams } from "./session-catalog-types.js";

export type CodexResidentCatalogCursor = {
  kind: "resident";
  queryId: string;
  anchor?: CodexCatalogOrderKey & { backwards: boolean };
};
export type CodexNativeCatalogCursor = {
  kind: "native";
  queryId: string;
  cursor?: string;
  backwards: boolean;
  /** A resident-to-native transition can start inside one native page. */
  anchorThreadId?: string;
};

export function readCodexCatalogCursor(
  homeId: string,
  params: CodexSessionCatalogPageParams,
): CodexResidentCatalogCursor | CodexNativeCatalogCursor {
  const queryId = createHash("sha256")
    .update(
      JSON.stringify([
        homeId,
        params.cwd?.trim() ?? "",
        params.searchTerm?.trim().toLocaleLowerCase() ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  const encoded = readControlCursor(params.cursor, "request");
  if (!encoded) {
    return { kind: "resident", queryId };
  }
  const invalid = () => new CatalogParamsError("invalid Codex resident catalog cursor");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    throw invalid();
  }
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== queryId) {
    throw invalid();
  }
  if (value[1] === "native") {
    if (
      (value[2] !== null && typeof value[2] !== "string") ||
      typeof value[3] !== "boolean" ||
      (value[4] !== null && (typeof value[4] !== "string" || !value[4] || value[4].length > 256))
    ) {
      throw invalid();
    }
    return {
      kind: "native",
      queryId,
      backwards: value[3],
      ...(value[2] !== null ? { cursor: readControlCursor(value[2], "native request") } : {}),
      ...(value[4] !== null ? { anchorThreadId: value[4] } : {}),
    };
  }
  if (
    typeof value[1] !== "number" ||
    !Number.isFinite(value[1]) ||
    typeof value[2] !== "string" ||
    value[2].length > 256 ||
    typeof value[3] !== "number" ||
    !Number.isSafeInteger(value[3]) ||
    typeof value[4] !== "boolean"
  ) {
    throw invalid();
  }
  return {
    kind: "resident",
    queryId,
    anchor: {
      updatedAt: value[1],
      recencyAt: value[1],
      threadId: value[2],
      sourceOrder: value[3],
      backwards: value[4],
    },
  };
}

export function encodeCodexResidentCursor(
  queryId: string,
  row: CodexCatalogOrderKey,
  backwards: boolean,
): string {
  return Buffer.from(
    JSON.stringify([
      queryId,
      codexCatalogRowRecency(row),
      row.threadId,
      row.sourceOrder ?? 0,
      backwards,
    ]),
  ).toString("base64url");
}

export function encodeCodexNativeCursor(cursor: Omit<CodexNativeCatalogCursor, "kind">): string {
  const value = Buffer.from(
    JSON.stringify([
      cursor.queryId,
      "native",
      cursor.cursor ?? null,
      cursor.backwards,
      cursor.anchorThreadId ?? null,
    ]),
  ).toString("base64url");
  readControlCursor(value, "native continuation");
  return value;
}
