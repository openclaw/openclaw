import type { SessionCompactionBoundaryMetadata } from "../../config/sessions/types.js";

export type BuildCompactBoundaryMetadataParams = {
  diagId: string;
  createdAt: number;
  sessionKey?: string;
  sessionId?: string;
  sessionAgentId?: string;
  channel?: string;
  accountId?: string;
  targetId?: string;
  threadId?: string | number;
  messageId?: string | number;
  livePendingDescendants?: boolean;
  sandboxEnabled?: boolean;
  sandboxWorkspaceAccess?: string;
  bashElevated?: unknown;
  provider?: string;
  model?: string;
  thinkLevel?: string;
  trigger?: string;
};

function compactBoundaryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? value.trim() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function compactBoundaryBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function buildCompactBoundaryMetadata(
  params: BuildCompactBoundaryMetadataParams,
): SessionCompactionBoundaryMetadata {
  const boundaryId = `compact-boundary:${params.diagId}`;
  return {
    version: 1,
    type: "compact.boundary",
    boundaryId,
    createdAt: params.createdAt,
    state: {
      sessionBinding: {
        sessionKey: compactBoundaryString(params.sessionKey),
        sessionId: compactBoundaryString(params.sessionId),
        agentId: compactBoundaryString(params.sessionAgentId),
        channel: compactBoundaryString(params.channel),
        accountId: compactBoundaryString(params.accountId),
        threadId: compactBoundaryString(params.threadId),
        messageId: compactBoundaryString(params.messageId),
      },
      approval: {
        captured: false,
        reason: "approval live state is captured by the dedicated approval mismatch guard",
      },
      outbound: {
        channel: compactBoundaryString(params.channel),
        targetId: compactBoundaryString(params.targetId),
        threadId: compactBoundaryString(params.threadId),
        replyToMessageId: compactBoundaryString(params.messageId),
      },
      children: {
        pendingDescendantState: "live-query-required",
        livePendingDescendants: compactBoundaryBoolean(params.livePendingDescendants),
      },
      policy: {
        sandboxEnabled: compactBoundaryBoolean(params.sandboxEnabled),
        sandboxWorkspaceAccess: compactBoundaryString(params.sandboxWorkspaceAccess),
        bashElevated: compactBoundaryBoolean(params.bashElevated),
        provider: compactBoundaryString(params.provider),
        model: compactBoundaryString(params.model),
        thinkingLevel: compactBoundaryString(params.thinkLevel),
        trigger: compactBoundaryString(params.trigger),
      },
    },
  };
}

export const __testing = {
  compactBoundaryBoolean,
  compactBoundaryString,
};
