import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppRuntimeTool } from "./app-runtime-tools.js";
import type { CodexPluginOwnedApp } from "./plugin-inventory.js";
import {
  normalizeAppToolApprovalMode,
  type CodexAppToolApprovalMode,
} from "./scheduled-app-tool-policy.js";

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
  app: Pick<CodexPluginOwnedApp, "id" | "toolSummaries">,
  runtimeTools: ReadonlyMap<string, CodexAppRuntimeTool> | undefined,
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
  const readable = new Map<string, boolean>();
  for (const tool of app.toolSummaries ?? []) {
    readable.set(
      tool.name,
      readable.get(tool.name) !== false &&
        isExplicitlyTrue(tool.isReadOnly) &&
        isExplicitlyTrue(tool.isEnabled),
    );
  }
  for (const [name, tool] of runtimeTools ?? []) {
    // Codex looks up the complete native entry by raw name, then title. Project the
    // winning entry onto the raw name so a different tool cannot inherit a read grant.
    const native = asOptionalRecord(nativeTools[name] ?? (tool.title && nativeTools[tool.title]));
    const approvalMode = normalizeAppToolApprovalMode(native?.approval_mode);
    enabledByKey.set(name, {
      enabled:
        tool.readOnlyHint === true &&
        tool.actionName !== undefined &&
        readable.get(tool.actionName) === true &&
        native?.enabled !== false,
      ...(approvalMode ? { approval_mode: approvalMode } : {}),
    });
  }
  return Object.fromEntries([...enabledByKey].toSorted(([a], [b]) => a.localeCompare(b)));
}

// Keep runtime admission strict even if upstream JSON violates the static contract.
function isExplicitlyTrue(value: unknown): boolean {
  return value === true;
}
