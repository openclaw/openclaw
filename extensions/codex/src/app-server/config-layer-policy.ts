import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexConfigReadParams, CodexConfigReadResponse } from "./protocol-control-plane.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

// Native session flags override these layers. Legacy managed layers sit above
// them, so app admission and restricted turns cannot replace their tool policy.
export const CODEX_SESSION_OVERRIDABLE_LAYER_TYPES = new Set([
  "packagedDefaults",
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
]);

export type CodexConfigReadClient = {
  request(
    method: "config/read",
    params: CodexConfigReadParams,
    options: { timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void },
  ): Promise<CodexConfigReadResponse>;
};

/** Read one effective snapshot for the current boundary's reviewer and tool-policy checks. */
export async function readCodexEffectiveConfig(
  client: CodexConfigReadClient,
  cwd: string,
  options: Parameters<CodexConfigReadClient["request"]>[2],
): Promise<CodexConfigReadResponse> {
  const response = await client.request(
    "config/read",
    { cwd: path.resolve(cwd), includeLayers: true },
    options,
  );
  if (!isJsonObject(response) || !isJsonObject(response.config)) {
    throw new Error("Codex config/read returned an invalid effective config");
  }
  return response;
}

export function readCodexConfigValue(config: JsonObject, key: string): JsonValue | undefined {
  if (Object.hasOwn(config, key)) {
    return config[key];
  }
  const separator = key.indexOf(".");
  if (separator < 0) {
    return undefined;
  }
  const child = config[key.slice(0, separator)];
  return isJsonObject(child) ? readCodexConfigValue(child, key.slice(separator + 1)) : undefined;
}

export function readCodexAuthoredConfigValue(
  snapshot: CodexConfigReadResponse,
  key: string,
): JsonValue | undefined {
  const origin = snapshot.origins[key];
  if (!origin) {
    return undefined;
  }
  const effective = readCodexConfigValue(snapshot.config, key);
  if (effective !== undefined) {
    return effective;
  }
  // Typed config/read projections omit some native keys. Its origin identifies
  // the winning enabled raw layer; array order also includes disabled layers.
  const layer = snapshot.layers?.find(
    (entry) =>
      isJsonObject(entry) &&
      !entry.disabledReason &&
      entry.version === origin.version &&
      isDeepStrictEqual(entry.name, origin.name),
  );
  return isJsonObject(layer) && isJsonObject(layer.config)
    ? readCodexConfigValue(layer.config, key)
    : undefined;
}
