import { root } from "@openclaw/fs-safe/root";
import { parseDocument } from "yaml";
import { AUXILIARY_MAX_BYTES } from "./limits.js";
export const safeRoot = (rootPath: string, maxBytes = AUXILIARY_MAX_BYTES) =>
  root(rootPath, {
    maxBytes,
    symlinks: "reject",
    hardlinks: "reject",
  });
export async function readText(
  rootPath: string,
  relative: string,
  maxBytes = AUXILIARY_MAX_BYTES,
): Promise<string> {
  const result = await (await safeRoot(rootPath, maxBytes)).read(relative);
  return new TextDecoder("utf-8", { fatal: true }).decode(result.buffer);
}
export const parseYaml = (raw: string): unknown => {
  const doc = parseDocument(raw, { uniqueKeys: true, schema: "core" });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error(
      "Invalid YAML: " + [...doc.errors, ...doc.warnings].map((e) => e.message).join("; "),
    );
  }
  const value = doc.toJS({ maxAliasCount: 0 });
  // Reject non-JSON values and deep metadata before exposing it through the host.
  const walk = (x: unknown, depth = 0): void => {
    if (depth > 20) {
      throw new Error("Metadata nesting exceeds 20 levels");
    }
    if (x === null || typeof x === "string" || typeof x === "boolean") {
      return;
    }
    if (typeof x === "number" && Number.isFinite(x)) {
      return;
    }
    if (Array.isArray(x)) {
      x.forEach((v) => walk(v, depth + 1));
      return;
    }
    if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
      Object.values(x).forEach((v) => walk(v, depth + 1));
      return;
    }
    throw new Error("Metadata must contain finite JSON-compatible values");
  };
  walk(value);
  return value;
};
