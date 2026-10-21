import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexPluginOwnedApp } from "./plugin-inventory.js";
import type { JsonObject } from "./protocol.js";

/** Native per-tool enabled takes precedence over both app flags and defaults. */
export function buildCodexAppReadOnlyTools(
  config: Record<string, unknown>,
  app: Pick<CodexPluginOwnedApp, "id" | "toolNamePrefix" | "toolSummaries">,
  previousTools: Record<string, boolean> = {},
): Record<string, boolean> {
  const nativeApp = asOptionalRecord(asOptionalRecord(config.apps)?.[app.id]);
  const nativeTools = asOptionalRecord(nativeApp?.tools) ?? {};
  // Explicitly revoke old overrides: native TOML tables merge under thread config.
  const enabledByKey = new Map(
    [...new Set([...Object.keys(nativeTools), ...Object.keys(previousTools)])].map((key) => [
      key,
      false,
    ]),
  );
  const current = new Map<string, boolean>();
  for (const tool of app.toolSummaries ?? []) {
    // The backend exposes lower-case resource names, with the original resource
    // name as title. Codex matches full name first, then title.
    const resourceName = app.toolNamePrefix ? `${app.toolNamePrefix}_${tool.name}` : undefined;
    const keys = [
      ...new Set([
        tool.name,
        tool.name.toLowerCase(),
        tool.title,
        tool.title?.toLowerCase(),
        resourceName,
        resourceName?.toLowerCase(),
      ]),
    ].filter((key): key is string => Boolean(key));
    const allowed =
      isExplicitlyTrue(tool.isReadOnly) &&
      isExplicitlyTrue(tool.isEnabled) &&
      keys.every((key) => asOptionalRecord(nativeTools[key])?.enabled !== false);
    for (const key of keys) {
      // Ambiguous aliases must not let a read grant enable a different write tool.
      current.set(key, (current.get(key) ?? true) && allowed);
    }
  }
  for (const [key, enabled] of current) {
    enabledByKey.set(key, enabled);
  }
  return Object.fromEntries([...enabledByKey].toSorted(([a], [b]) => a.localeCompare(b)));
}

export function readOnlyToolsConfig(tools: Record<string, boolean>): JsonObject {
  return Object.fromEntries(Object.entries(tools).map(([key, enabled]) => [key, { enabled }]));
}

export function readOnlyToolEnabled(
  tools: Record<string, boolean>,
  name: string,
  title?: string,
): boolean {
  return (tools[name] ?? (title === undefined ? undefined : tools[title])) === true;
}

// Keep runtime admission strict even if upstream JSON violates the static contract.
function isExplicitlyTrue(value: unknown): boolean {
  return value === true;
}
