import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
} from "../../infra/plugin-approvals.js";
import type { NativeHookRelayPermissionApprovalRequest } from "./native-hook-relay-types.js";
import { readOptionalNonEmptyString, truncateRelayText } from "./native-hook-relay-utils.js";

export function formatNativeHookRelayApprovalPresentation(
  request: NativeHookRelayPermissionApprovalRequest,
): { title: string; description: string } {
  return formatHarnessApprovalPresentation({
    title: "Codex permission request",
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
  return stripAnsi(value)
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
