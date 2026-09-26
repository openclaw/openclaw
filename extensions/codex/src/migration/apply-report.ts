import type { CodexPluginActivationResult } from "../app-server/plugin-activation.js";

export function codexPluginActivationReportState(result: CodexPluginActivationResult): {
  installed?: boolean;
  enabled?: boolean;
} {
  switch (result.reason) {
    case "already_active":
    case "installed":
      return { installed: true, enabled: true };
    case "auth_required":
    case "refresh_failed":
      return { installed: true, enabled: false };
    case "disabled":
    case "install_failed":
    case "marketplace_missing":
    case "plugin_missing":
      return { installed: false, enabled: false };
  }
  const exhaustiveReason: never = result.reason;
  return exhaustiveReason;
}
