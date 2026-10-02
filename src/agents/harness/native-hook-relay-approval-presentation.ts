import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import type {
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import { readOptionalNonEmptyString, truncateRelayText } from "./native-hook-relay-utils.js";

export function formatNativeHookRelayApprovalPresentation(
  request: NativeHookRelayPermissionApprovalRequest,
): { title: string; description: string } {
  return formatHarnessApprovalPresentation({
    title: `${nativeHookRelayProviderDisplayName(request.provider)} permission request`,
    description: formatPermissionApprovalDescription(request),
  });
}

export function formatPermissionApprovalDescription(
  request: NativeHookRelayPermissionApprovalRequest,
): string {
  const lines = [
    `Tool: ${sanitizeApprovalText(request.toolName)}`,
    request.cwd ? `Cwd: ${sanitizeApprovalText(request.cwd)}` : undefined,
    request.model ? `Model: ${sanitizeApprovalText(request.model)}` : undefined,
    formatToolInputPreview(request.toolInput),
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function formatToolInputPreview(toolInput: Record<string, unknown>): string | undefined {
  const command = readOptionalNonEmptyString(toolInput.command);
  if (command) {
    return `Command: ${truncateRelayText(sanitizeApprovalText(command), 240)}`;
  }
  const keys = Object.keys(toolInput).map(sanitizeApprovalText).filter(Boolean).toSorted();
  if (!keys.length) {
    return undefined;
  }
  const shownKeys = keys.slice(0, 12).join(", ");
  const omitted = keys.length > 12 ? ` (${keys.length - 12} omitted)` : "";
  return `Input keys: ${shownKeys}${omitted}`;
}

function sanitizeApprovalText(value: string): string {
  let sanitized = "";
  for (const char of stripAnsi(value)) {
    const codePoint = char.codePointAt(0);
    sanitized += codePoint != null && isUnsafeApprovalCodePoint(codePoint) ? " " : char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

function isUnsafeApprovalCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function nativeHookRelayProviderDisplayName(provider: NativeHookRelayProvider): string {
  return provider === "codex" ? "Codex" : provider;
}

export function formatHarnessApprovalPresentation(input: { title: string; description: string }): {
  title: string;
  description: string;
} {
  return {
    title: truncateRelayText(sanitizeApprovalText(input.title), PLUGIN_APPROVAL_TITLE_MAX_LENGTH),
    description: truncateRelayText(
      input.description.split("\n").map(sanitizeApprovalText).join("\n"),
      PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
    ),
  };
}
