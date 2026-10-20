import path from "node:path";
import { exists, object, readJson } from "./files.js";
import { sourceId } from "./normalize.js";
import type { GrokCredentialSelector } from "./types.js";

function localSlot(data: Record<string, unknown>, scope?: string): Record<string, unknown> {
  if (data.version === 1) {
    return object(data.secrets) ?? {};
  }
  if (data.version === 2) {
    if (!scope && Object.keys(object(data.accounts) ?? {}).length) {
      throw new Error("The active Grok account scope is unavailable.");
    }
    return object(scope ? object(data.accounts)?.[scope] : undefined) ?? {};
  }
  throw new Error("Unsupported Grok user-secret storage version.");
}

/** Inspects encrypted field names only; sign-in tokens are in a different file. */
export async function listLocalCredentialSelectors(
  root: string,
  accountScope?: string,
): Promise<GrokCredentialSelector[]> {
  const sourcePath = path.join(root, "user-secrets.json");
  if (!(await exists(sourcePath))) {
    return [];
  }
  const data = await readJson(sourcePath, 1024 * 1024);
  return Object.keys(localSlot(data, accountScope))
    .toSorted()
    .map((name) => ({
      id: `secret:${sourceId(name)}`,
      name,
      kind: "local-user-secret",
      sourcePath,
      accountScope,
    }));
}
