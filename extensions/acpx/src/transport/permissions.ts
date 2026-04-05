import {
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "../errors.js";
import type { NonInteractivePermissionPolicy, PermissionMode } from "../runtime-types.js";
import { promptForPermission } from "./permission-prompt.js";

type PermissionDecision = "approved" | "denied" | "cancelled";
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  "deny-all": 0,
  "approve-reads": 1,
  "approve-all": 2,
};

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function pickOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function inferToolKind(params: RequestPermissionRequest): ToolKind | undefined {
  if (params.toolCall.kind) {
    return params.toolCall.kind;
  }

  const title = params.toolCall.title?.trim().toLowerCase();
  if (!title) {
    return undefined;
  }

  const head = title.split(":", 1)[0]?.trim();
  if (!head) {
    return undefined;
  }

  if (head.includes("read") || head.includes("cat")) {
    return "read";
  }
  if (head.includes("search") || head.includes("find") || head.includes("grep")) {
    return "search";
  }
  if (head.includes("write") || head.includes("edit") || head.includes("patch")) {
    return "edit";
  }
  if (head.includes("delete") || head.includes("remove")) {
    return "delete";
  }
  if (head.includes("move") || head.includes("rename")) {
    return "move";
  }
  if (head.includes("run") || head.includes("execute") || head.includes("bash")) {
    return "execute";
  }
  if (head.includes("fetch") || head.includes("http") || head.includes("url")) {
    return "fetch";
  }
  if (head.includes("think")) {
    return "think";
  }

  return "other";
}

function isAutoApprovedReadKind(kind: ToolKind | undefined): boolean {
  return kind === "read" || kind === "search";
}

async function promptForToolPermission(params: RequestPermissionRequest): Promise<boolean> {
  const toolName = params.toolCall.title ?? "tool";
  const toolKind = inferToolKind(params) ?? "other";
  return await promptForPermission({
    prompt: `\n[permission] Allow ${toolName} [${toolKind}]? (y/N) `,
  });
}

function canPromptForPermission(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export function permissionModeSatisfies(actual: PermissionMode, required: PermissionMode): boolean {
  return PERMISSION_MODE_RANK[actual] >= PERMISSION_MODE_RANK[required];
}

export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  mode: PermissionMode,
  nonInteractivePolicy: NonInteractivePermissionPolicy = "deny",
): Promise<RequestPermissionResponse> {
  const options = params.options ?? [];
  if (options.length === 0) {
    return cancelled();
  }

  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);

  if (mode === "approve-all") {
    if (allowOption) {
      return selected(allowOption.optionId);
    }
    return selected(options[0].optionId);
  }

  if (mode === "deny-all") {
    if (rejectOption) {
      return selected(rejectOption.optionId);
    }
    return cancelled();
  }

  const kind = inferToolKind(params);
  if (isAutoApprovedReadKind(kind) && allowOption) {
    return selected(allowOption.optionId);
  }

  if (!canPromptForPermission()) {
    if (nonInteractivePolicy === "fail") {
      throw new PermissionPromptUnavailableError();
    }
    if (rejectOption) {
      return selected(rejectOption.optionId);
    }
    return cancelled();
  }

  const approved = await promptForToolPermission(params);
  if (approved && allowOption) {
    return selected(allowOption.optionId);
  }
  if (!approved && rejectOption) {
    return selected(rejectOption.optionId);
  }
  return cancelled();
}

export function classifyPermissionDecision(
  params: RequestPermissionRequest,
  response: RequestPermissionResponse,
): PermissionDecision {
  if (response.outcome.outcome !== "selected") {
    return "cancelled";
  }

  const selectedOptionId = response.outcome.optionId;
  const selectedOption = params.options.find((option) => option.optionId === selectedOptionId);

  if (!selectedOption) {
    return "cancelled";
  }

  if (selectedOption.kind === "allow_once" || selectedOption.kind === "allow_always") {
    return "approved";
  }

  return "denied";
}
