import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeAppToolApprovalMode,
  type CodexAppToolApprovalMode,
} from "./app-tool-approval-mode.js";
import type { CodexPluginOwnedApp } from "./plugin-inventory.js";

export type CodexAppReadOnlyTools = Record<
  string,
  {
    enabled: boolean;
    approval_mode?: CodexAppToolApprovalMode;
  }
>;

/** Native per-tool enabled takes precedence over both app flags and defaults. */
export function buildCodexAppReadOnlyTools(
  config: Record<string, unknown>,
  app: Pick<CodexPluginOwnedApp, "id" | "toolNamePrefix" | "toolSummaries">,
  previousTools: CodexAppReadOnlyTools = {},
): CodexAppReadOnlyTools {
  const nativeApp = asOptionalRecord(asOptionalRecord(config.apps)?.[app.id]);
  const nativeTools = asOptionalRecord(nativeApp?.tools) ?? {};
  // Explicitly revoke old overrides: native TOML tables merge under thread config.
  const enabledByKey = new Map<string, CodexAppReadOnlyTools[string]>(
    [...new Set([...Object.keys(nativeTools), ...Object.keys(previousTools)])].map((key) => [
      key,
      { enabled: false },
    ]),
  );
  const current = new Map<string, CodexAppReadOnlyTools[string]>();
  for (const tool of app.toolSummaries ?? []) {
    // The backend exposes lower-case resource names, with the original resource
    // name as title. Codex matches full name first, then title.
    const resourceName = app.toolNamePrefix ? `${app.toolNamePrefix}_${tool.name}` : undefined;
    // Bare summary names and display titles can name a different callable resource.
    const keys = resourceName ? [...new Set([resourceName, resourceName.toLowerCase()])] : [];
    const allowed = isExplicitlyTrue(tool.isReadOnly) && isExplicitlyTrue(tool.isEnabled);
    for (const key of keys) {
      // Ambiguous aliases must not let a read grant enable a different write tool.
      // A synthesized name entry shadows the whole native title entry. Carry
      // its enablement and approval along; leave app/link defaults to native policy.
      const native = asOptionalRecord(
        nativeTools[key] ?? (resourceName ? nativeTools[resourceName] : undefined),
      );
      let approvalMode = normalizeAppToolApprovalMode(native?.approval_mode);
      const previous = current.get(key);
      if (previous && previous.approval_mode !== approvalMode) {
        // Shared aliases cannot weaken either tool's saved consent requirement.
        approvalMode = "prompt";
      }
      current.set(key, {
        enabled: (previous?.enabled ?? true) && allowed && native?.enabled !== false,
        ...(approvalMode ? { approval_mode: approvalMode } : {}),
      });
    }
  }
  for (const [key, enabled] of current) {
    enabledByKey.set(key, enabled);
  }
  return Object.fromEntries([...enabledByKey].toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Project verified native per-tool grants while retaining the surrounding app policy. */
export function withCodexAppReadOnlyTools(
  config: Record<string, unknown>,
  appId: string,
  tools: CodexAppReadOnlyTools | undefined,
): Record<string, unknown> {
  if (tools === undefined) {
    return config;
  }
  const nativeApps = asOptionalRecord(config.apps);
  const nativeApp = asOptionalRecord(nativeApps?.[appId]);
  return {
    ...config,
    apps: {
      ...nativeApps,
      [appId]: { ...nativeApp, tools: { ...asOptionalRecord(nativeApp?.tools), ...tools } },
    },
  };
}

export function readOnlyToolEnabled(
  tools: CodexAppReadOnlyTools,
  name: string,
  title?: string,
): boolean {
  return (tools[name] ?? (title === undefined ? undefined : tools[title]))?.enabled === true;
}

// Keep runtime admission strict even if upstream JSON violates the static contract.
function isExplicitlyTrue(value: unknown): boolean {
  return value === true;
}
