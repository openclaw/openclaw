import path from "node:path";
import {
  buildTeamsActionApprovalCard,
  claimActionApprovalFlow,
  createWaitingActionApprovalFlow,
  decodeActionApprovalInteractivePayload,
  deliverTeamsActionApprovalCard,
  failClaimedActionApprovalFlow,
  finishClaimedActionApprovalFlow,
  loadActionApprovalFlow,
  resolveActionApprovalDecision,
  type ActionApprovalActionMetadata,
} from "openclaw/plugin-sdk/action-approval-runtime";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginInteractiveRegistration } from "openclaw/plugin-sdk/plugin-runtime";
import { pinMessageMSTeams } from "./graph-messages.js";
import {
  sendThreadArtifactMSTeams,
  sendThreadMessageMSTeams,
  sendThreadPollMSTeams,
} from "./thread-send.js";
import { readMSTeamsApproverIds, resolveMSTeamsThreadTarget } from "./thread-targeting.js";

export const MSTEAMS_THREAD_APPROVAL_NAMESPACE = "msteams.thread-approval";
export const MSTEAMS_THREAD_QUEUE_TOOL_NAME = "msteams_thread_queue_action";

type ThreadToolContext = OpenClawPluginToolContext;

type ThreadActionOperation = "post_summary" | "create_poll" | "pin_message" | "upload_artifact";

type ThreadActionSnapshotBase = {
  kind: "msteams.thread.action";
  operation: ThreadActionOperation;
  teamId: string;
  channelId: string;
  rootMessageId: string;
  conversationId: string;
  approverIds: string[];
};

type PostSummarySnapshot = ThreadActionSnapshotBase & {
  operation: "post_summary";
  text: string;
};

type CreatePollSnapshot = ThreadActionSnapshotBase & {
  operation: "create_poll";
  question: string;
  options: string[];
  maxSelections?: number;
};

type PinMessageSnapshot = ThreadActionSnapshotBase & {
  operation: "pin_message";
  messageId: string;
};

type UploadArtifactSnapshot = ThreadActionSnapshotBase & {
  operation: "upload_artifact";
  text: string;
  mediaUrl: string;
  filename?: string;
  mediaLocalRoots?: string[];
};

type ThreadActionSnapshot =
  | PostSummarySnapshot
  | CreatePollSnapshot
  | PinMessageSnapshot
  | UploadArtifactSnapshot;

type MSTeamsThreadInteractiveContext = {
  senderId?: string;
  interaction: {
    payload: string;
  };
  respond: {
    reply: (params: { text: string }) => Promise<void>;
    editMessage: (params: { text?: string; card?: Record<string, unknown> }) => Promise<void>;
  };
};

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeApproverIds(params: {
  rawParams: Record<string, unknown>;
  toolContext: ThreadToolContext;
}): string[] {
  return readMSTeamsApproverIds(params.rawParams);
}

function normalizeMediaUrl(params: {
  rawParams: Record<string, unknown>;
  toolContext: ThreadToolContext;
}): string | undefined {
  const mediaUrl =
    readTrimmedString(params.rawParams.media) ??
    readTrimmedString(params.rawParams.filePath) ??
    readTrimmedString(params.rawParams.path);
  if (!mediaUrl) {
    return undefined;
  }
  if (/^[a-z]+:\/\//i.test(mediaUrl) || path.isAbsolute(mediaUrl)) {
    return mediaUrl;
  }
  return params.toolContext.workspaceDir
    ? path.resolve(params.toolContext.workspaceDir, mediaUrl)
    : mediaUrl;
}

function normalizeMediaLocalRoots(toolContext: ThreadToolContext): string[] | undefined {
  const roots = [toolContext.workspaceDir, toolContext.agentDir].filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return roots.length > 0 ? Array.from(new Set(roots)) : undefined;
}

function buildThreadActionMetadata(snapshot: ThreadActionSnapshot): ActionApprovalActionMetadata {
  const commonFacts = [
    { title: "Team", value: snapshot.teamId },
    { title: "Channel", value: snapshot.channelId },
    { title: "Thread", value: snapshot.rootMessageId },
  ];
  switch (snapshot.operation) {
    case "post_summary":
      return {
        kind: snapshot.kind,
        title: "Approve Teams thread summary post",
        summary: snapshot.text.slice(0, 160),
        facts: [...commonFacts, { title: "Operation", value: snapshot.operation }],
        metadata: { approverIds: snapshot.approverIds },
      };
    case "create_poll":
      return {
        kind: snapshot.kind,
        title: "Approve Teams thread poll",
        summary: snapshot.question,
        facts: [
          ...commonFacts,
          { title: "Operation", value: snapshot.operation },
          { title: "Options", value: snapshot.options.join(", ") },
        ],
        metadata: { approverIds: snapshot.approverIds },
      };
    case "pin_message":
      return {
        kind: snapshot.kind,
        title: "Approve Teams thread pin",
        summary: `Pin message ${snapshot.messageId}`,
        facts: [
          ...commonFacts,
          { title: "Operation", value: snapshot.operation },
          { title: "Message", value: snapshot.messageId },
        ],
        metadata: { approverIds: snapshot.approverIds },
      };
    case "upload_artifact":
      return {
        kind: snapshot.kind,
        title: "Approve Teams thread artifact upload",
        summary: snapshot.filename ?? path.basename(snapshot.mediaUrl),
        highRisk: true,
        facts: [
          ...commonFacts,
          { title: "Operation", value: snapshot.operation },
          { title: "Artifact", value: snapshot.filename ?? snapshot.mediaUrl },
        ],
        metadata: { approverIds: snapshot.approverIds },
      };
  }
  throw new Error(`Unsupported Teams thread operation: ${snapshot.operation}`);
}

function createThreadActionSnapshot(params: {
  rawParams: Record<string, unknown>;
  toolContext: ThreadToolContext;
}): ThreadActionSnapshot {
  const operation = readTrimmedString(params.rawParams.operation) as
    | ThreadActionOperation
    | undefined;
  if (
    operation !== "post_summary" &&
    operation !== "create_poll" &&
    operation !== "pin_message" &&
    operation !== "upload_artifact"
  ) {
    throw new Error(
      "operation must be one of post_summary, create_poll, pin_message, or upload_artifact.",
    );
  }
  const target = resolveMSTeamsThreadTarget({
    rawParams: params.rawParams,
    toolContext: params.toolContext,
  });
  const approverIds = normalizeApproverIds(params);
  if (approverIds.length === 0) {
    throw new Error("Teams thread approvals require at least one approver id.");
  }
  const base: ThreadActionSnapshotBase = {
    kind: "msteams.thread.action",
    operation,
    approverIds,
    ...target,
  };
  if (operation === "post_summary") {
    const text =
      readTrimmedString(params.rawParams.text) ??
      readTrimmedString(params.rawParams.summary) ??
      readTrimmedString(params.rawParams.content) ??
      readTrimmedString(params.rawParams.message);
    if (!text) {
      throw new Error("post_summary requires text.");
    }
    return { ...base, operation, text };
  }
  if (operation === "create_poll") {
    const question = readTrimmedString(params.rawParams.question);
    const options = readStringArray(params.rawParams.options);
    if (!question || options.length < 2) {
      throw new Error("create_poll requires question and at least two options.");
    }
    const maxSelections = readNumber(params.rawParams.maxSelections);
    return {
      ...base,
      operation,
      question,
      options,
      ...(maxSelections !== undefined ? { maxSelections } : {}),
    };
  }
  if (operation === "pin_message") {
    const messageId =
      readTrimmedString(params.rawParams.messageId) ??
      readTrimmedString(params.rawParams.pinMessageId);
    return {
      ...base,
      operation,
      messageId: messageId ?? base.rootMessageId,
    };
  }
  const mediaUrl = normalizeMediaUrl(params);
  if (!mediaUrl) {
    throw new Error("upload_artifact requires media, filePath, or path.");
  }
  const text =
    readTrimmedString(params.rawParams.text) ??
    readTrimmedString(params.rawParams.summary) ??
    readTrimmedString(params.rawParams.message) ??
    "";
  return {
    ...base,
    operation,
    text,
    mediaUrl,
    ...(readTrimmedString(params.rawParams.filename)
      ? { filename: readTrimmedString(params.rawParams.filename) }
      : {}),
    ...(normalizeMediaLocalRoots(params.toolContext)
      ? { mediaLocalRoots: normalizeMediaLocalRoots(params.toolContext) }
      : {}),
  };
}

async function executeThreadAction(api: OpenClawPluginApi, snapshot: ThreadActionSnapshot) {
  switch (snapshot.operation) {
    case "post_summary":
      return {
        ok: true as const,
        result: await sendThreadMessageMSTeams({
          cfg: api.config,
          conversationId: snapshot.conversationId,
          rootMessageId: snapshot.rootMessageId,
          text: snapshot.text,
        }),
      };
    case "create_poll":
      return {
        ok: true as const,
        result: await sendThreadPollMSTeams({
          cfg: api.config,
          conversationId: snapshot.conversationId,
          rootMessageId: snapshot.rootMessageId,
          question: snapshot.question,
          options: snapshot.options,
          maxSelections: snapshot.maxSelections,
        }),
      };
    case "pin_message":
      return {
        ok: true as const,
        result: await pinMessageMSTeams({
          cfg: api.config,
          to: `${snapshot.teamId}/${snapshot.channelId}`,
          messageId: snapshot.messageId,
        }),
      };
    case "upload_artifact":
      return {
        ok: true as const,
        result: await sendThreadArtifactMSTeams({
          cfg: api.config,
          conversationId: snapshot.conversationId,
          rootMessageId: snapshot.rootMessageId,
          text: snapshot.text,
          mediaUrl: snapshot.mediaUrl,
          filename: snapshot.filename,
          mediaLocalRoots: snapshot.mediaLocalRoots,
        }),
      };
  }
  throw new Error(`Unsupported Teams thread operation: ${snapshot.operation}`);
}

async function editApprovalCard(ctx: MSTeamsThreadInteractiveContext, text: string) {
  await ctx.respond.editMessage({ text });
}

export function createMSTeamsThreadQueueTool(
  api: OpenClawPluginApi,
  toolContext: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: MSTEAMS_THREAD_QUEUE_TOOL_NAME,
    label: "Queue Teams thread side effect",
    description:
      "Queue a Teams channel-thread side effect behind a durable approval card. Requires explicit teamId, channelId, and rootMessageId.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string" },
        teamId: { type: "string" },
        channelId: { type: "string" },
        rootMessageId: { type: "string" },
        conversationId: { type: "string" },
        approverIds: { type: "array", items: { type: "string" } },
        text: { type: "string" },
        summary: { type: "string" },
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        maxSelections: { type: "number" },
        messageId: { type: "string" },
        media: { type: "string" },
        filePath: { type: "string" },
        path: { type: "string" },
        filename: { type: "string" },
      },
      required: ["operation", "teamId", "channelId", "rootMessageId"],
    },
    execute: async (_callId: string, rawParams: Record<string, unknown>) => {
      const context = toolContext;
      const snapshot = createThreadActionSnapshot({
        rawParams,
        toolContext: context,
      });
      const taskFlow = api.runtime.taskFlow.fromToolContext(context);
      const action = buildThreadActionMetadata(snapshot);
      const created = createWaitingActionApprovalFlow({
        taskFlow,
        controllerId: "extensions/msteams/thread-approval",
        goal: `Approve ${snapshot.operation} for Teams thread ${snapshot.rootMessageId}`,
        currentStep: "queue-thread-action",
        waitingStep: "awaiting-approval",
        action,
        snapshot,
      });
      const card = buildTeamsActionApprovalCard({
        namespace: MSTEAMS_THREAD_APPROVAL_NAMESPACE,
        ownerSessionKey: taskFlow.sessionKey,
        flowId: created.flow.flowId,
        expectedRevision: created.expectedRevision,
        snapshotHash: created.snapshotHash,
        action,
      });
      for (const approverId of snapshot.approverIds) {
        await deliverTeamsActionApprovalCard({
          cfg: api.config,
          to: `user:${approverId}`,
          card,
          requesterSenderId: context.requesterSenderId,
          sessionKey: context.sessionKey,
          sessionId: context.sessionId,
          agentId: context.agentId,
        });
      }
      return jsonResult({
        queued: true,
        operation: snapshot.operation,
        flowId: created.flow.flowId,
        expectedRevision: created.expectedRevision,
        snapshotHash: created.snapshotHash,
        approverIds: snapshot.approverIds,
        teamId: snapshot.teamId,
        channelId: snapshot.channelId,
        rootMessageId: snapshot.rootMessageId,
      });
    },
  } satisfies AnyAgentTool;
}

export function registerMSTeamsThreadApproval(api: OpenClawPluginApi): void {
  api.registerTool(
    (toolContext: OpenClawPluginToolContext) => createMSTeamsThreadQueueTool(api, toolContext),
    {
      optional: true,
    },
  );
  api.registerInteractiveHandler({
    channel: "msteams",
    namespace: MSTEAMS_THREAD_APPROVAL_NAMESPACE,
    handler: async (rawCtx: unknown) => {
      const ctx = rawCtx as MSTeamsThreadInteractiveContext;
      const decoded = decodeActionApprovalInteractivePayload(ctx.interaction.payload);
      if (!decoded) {
        await ctx.respond.reply({ text: "This approval payload is invalid." });
        return { handled: true };
      }
      const taskFlow = api.runtime.taskFlow.bindSession({
        sessionKey: decoded.ownerSessionKey,
      });
      const loaded = loadActionApprovalFlow<ThreadActionSnapshot>({
        taskFlow,
        flowId: decoded.flowId,
        expectedRevision: decoded.expectedRevision,
        snapshotHash: decoded.snapshotHash,
      });
      if (!loaded.ok) {
        await editApprovalCard(ctx, `Approval could not be applied (${loaded.code}).`);
        return { handled: true };
      }
      if (!ctx.senderId || !loaded.snapshot.approverIds.includes(ctx.senderId)) {
        await ctx.respond.reply({ text: "You are not allowed to approve this action." });
        return { handled: true };
      }
      if (decoded.decision === "deny" || decoded.decision === "revise") {
        const resolved = resolveActionApprovalDecision({
          taskFlow,
          flowId: decoded.flowId,
          expectedRevision: decoded.expectedRevision,
          snapshotHash: decoded.snapshotHash,
          decision: decoded.decision,
          actorId: ctx.senderId,
        });
        await editApprovalCard(
          ctx,
          resolved.applied
            ? decoded.decision === "deny"
              ? "Denied."
              : "Revision requested."
            : `Approval could not be applied (${resolved.code}).`,
        );
        return { handled: true };
      }
      const claimed = claimActionApprovalFlow<ThreadActionSnapshot>({
        taskFlow,
        flowId: decoded.flowId,
        expectedRevision: decoded.expectedRevision,
        snapshotHash: decoded.snapshotHash,
        actorId: ctx.senderId,
      });
      if (!claimed.applied) {
        await editApprovalCard(
          ctx,
          claimed.code === "expired"
            ? "Approval expired."
            : `Approval could not be applied (${claimed.code}).`,
        );
        return { handled: true };
      }
      try {
        const executed = await executeThreadAction(api, claimed.snapshot);
        const finished = finishClaimedActionApprovalFlow({
          taskFlow,
          flowId: claimed.flow.flowId,
          expectedRevision: claimed.flow.revision,
          snapshotHash: claimed.snapshotHash,
          actorId: ctx.senderId,
          result: executed.result as never,
        });
        await editApprovalCard(
          ctx,
          finished.applied
            ? "Approved and executed."
            : `Approval could not be applied (${finished.code}).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Execution failed.";
        const failed = failClaimedActionApprovalFlow({
          taskFlow,
          flowId: claimed.flow.flowId,
          expectedRevision: claimed.flow.revision,
          snapshotHash: claimed.snapshotHash,
          actorId: ctx.senderId,
          blockedSummary: message,
        });
        await editApprovalCard(
          ctx,
          failed.applied
            ? `Approval failed safely: ${message}`
            : `Approval could not be applied (${failed.code}).`,
        );
      }
      return { handled: true };
    },
  } satisfies PluginInteractiveRegistration<unknown, "msteams">);
}
