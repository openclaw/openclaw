import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeAppToolApprovalMode,
  type CodexAppToolApprovalMode,
} from "./app-tool-approval-mode.js";
import type { CodexAppPolicyContextEntry } from "./plugin-thread-config.js";

export {
  normalizeAppToolApprovalMode,
  type CodexAppToolApprovalMode,
} from "./app-tool-approval-mode.js";

export type CodexScheduledAppTool = {
  title?: string;
  linkId?: string;
  requiresExplicitLinkId?: boolean;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export function readCurrentToolPolicy(
  config: Record<string, unknown>,
  appId: string,
  toolName: string,
  metadata: CodexScheduledAppTool | undefined,
  fallbackApprovalMode: CodexAppToolApprovalMode = "auto",
  admittedPolicy?: Pick<CodexAppPolicyContextEntry, "allowDestructiveActions" | "allowOpenWorld">,
): { enabled: boolean; approvalMode: CodexAppToolApprovalMode } {
  const apps = asOptionalRecord(config.apps);
  const app = asOptionalRecord(apps?.[appId]);
  const defaults = asOptionalRecord(apps?.["_default"]);
  const tools = asOptionalRecord(app?.tools);
  // Codex selects the full-name entry before the title entry, not each field
  // independently. Preserve that precedence for both enablement and approval.
  const tool = asOptionalRecord(
    tools?.[toolName] ?? (metadata?.title !== undefined ? tools?.[metadata.title] : undefined),
  );
  const toolApprovalMode = normalizeAppToolApprovalMode(tool?.approval_mode);
  let approvalMode =
    toolApprovalMode ??
    normalizeAppToolApprovalMode(app?.default_tools_approval_mode) ??
    normalizeAppToolApprovalMode(defaults?.default_tools_approval_mode) ??
    fallbackApprovalMode;
  if (!toolApprovalMode) {
    const links = asOptionalRecord(app?.links);
    if (metadata?.requiresExplicitLinkId) {
      // The account is chosen at call time; the stored per-tool ceiling must
      // cover every link and the default for links without an override.
      for (const link of Object.values(links ?? {})) {
        const linkMode = normalizeAppToolApprovalMode(
          asOptionalRecord(link)?.default_tools_approval_mode,
        );
        if (linkMode) {
          approvalMode = intersectToolApprovalMode(approvalMode, linkMode);
        }
      }
    } else if (metadata?.linkId) {
      approvalMode =
        normalizeAppToolApprovalMode(
          asOptionalRecord(links?.[metadata.linkId])?.default_tools_approval_mode,
        ) ?? approvalMode;
    }
  }
  const defaultToolsEnabled = app?.default_tools_enabled;
  // The thread admits this app over the native deny-by-default baseline.
  // Explicit account/tool settings still restrict that admission.
  const enabledByDefault = admittedPolicy ? true : defaults?.enabled !== false;
  const openWorldByDefault = admittedPolicy
    ? admittedPolicy.allowOpenWorld !== false
    : defaults?.open_world_enabled;
  return {
    enabled:
      (app ? app.enabled !== false : enabledByDefault) &&
      (typeof tool?.enabled === "boolean"
        ? tool.enabled
        : typeof defaultToolsEnabled === "boolean"
          ? defaultToolsEnabled
          : appToolHintsAllowed(metadata, {
              allowDestructiveActions:
                (app?.destructive_enabled ??
                  admittedPolicy?.allowDestructiveActions ??
                  defaults?.destructive_enabled) !== false,
              allowOpenWorld: (app?.open_world_enabled ?? openWorldByDefault) !== false,
            })),
    approvalMode,
  };
}

export function appToolHintsAllowed(
  tool: CodexScheduledAppTool | undefined,
  policy: Pick<CodexAppPolicyContextEntry, "allowDestructiveActions" | "allowOpenWorld">,
): boolean {
  // Codex treats missing annotations as destructive/open-world. Explicit tool
  // enablement bypasses its app flags, so enforce the stored cap before projecting it.
  return (
    (policy.allowDestructiveActions || tool?.destructiveHint === false) &&
    (policy.allowOpenWorld !== false || tool?.openWorldHint === false)
  );
}

export function intersectToolApprovalMode(
  captured: CodexAppToolApprovalMode,
  current: CodexAppToolApprovalMode,
): CodexAppToolApprovalMode {
  if (captured === current) {
    return captured;
  }
  if (captured === "prompt" || current === "prompt") {
    return "prompt";
  }
  if (captured === "approve") {
    return current;
  }
  if (current === "approve") {
    return captured;
  }
  // `auto` and `writes` are annotation-dependent and not totally ordered.
  return "prompt";
}
