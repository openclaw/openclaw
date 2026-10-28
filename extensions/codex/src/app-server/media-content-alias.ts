import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Names a regular Gateway-local file by size and SHA-256, without following
 * symlinks. Files larger than `maxBytes` are not read. */
export function readCodexMediaContentAlias(
  reference: string,
  maxBytes: number,
): string | undefined {
  try {
    const file = reference.startsWith("file://") ? fileURLToPath(reference) : reference;
    if (!path.isAbsolute(file)) {
      return undefined;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) {
      return undefined;
    }
    const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return `content:${stat.size}:${digest}`;
  } catch {
    return undefined;
  }
}
