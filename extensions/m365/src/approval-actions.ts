import { createHash } from "node:crypto";
import {
  buildTeamsActionApprovalCard,
  claimActionApprovalFlow,
  createWaitingActionApprovalFlow,
  decodeActionApprovalInteractivePayload,
  deliverTeamsActionApprovalCard,
  failClaimedActionApprovalFlow,
  finishClaimedActionApprovalFlow,
  hashActionApprovalSnapshot,
  loadActionApprovalFlow,
  resolveActionApprovalDecision,
  type ActionApprovalActionMetadata,
} from "openclaw/plugin-sdk/action-approval-runtime";
import type { PluginInteractiveRegistration } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { jsonResult } from "../runtime-api.js";
import type { M365MailMessageDetails, M365EmailRecipient } from "./mail.js";
import { hasOutlookHumanReplyAfter, sendOutlookReply } from "./mail.js";
import {
  assertM365WriteAllowed,
  createM365JsonGraphClient,
  resolveApproverTeamsUserIds,
  resolveM365RuntimeAccount,
  resolveM365RuntimeConfig,
  type M365ToolDeps,
} from "./runtime-common.js";

export const M365_APPROVAL_NAMESPACE = "m365.approval";

type M365InteractiveContext = {
  senderId?: string;
  respond: {
    reply: (params: { text: string }) => Promise<void>;
    editMessage: (params: { text?: string; card?: Record<string, unknown> }) => Promise<void>;
  };
  interaction: {
    payload: string;
  };
};

type M365MailReplySnapshot = {
  kind: "m365.mail.reply";
  accountId: string;
  identityId: string;
  mailboxUserId: string;
  messageId: string;
  conversationId?: string;
  sourceReceivedAt?: string;
  sourceSubject?: string;
  replyMode: "reply" | "replyAll";
  bodyMarkdown: string;
  normalizedRecipients: Array<{ address: string; name?: string }>;
  riskFlags: string[];
  approverTeamsUserIds: string[];
  idempotencyKey: string;
};

type M365ApprovalSnapshot = M365MailReplySnapshot;

function normalizeRecipients(
  recipients: M365EmailRecipient[],
): Array<{ address: string; name?: string }> {
  return Array.from(
    new Map(
      recipients
        .map((recipient) => recipient.address.trim().toLowerCase())
        .filter(Boolean)
        .map((address) => [address, address] as const),
    ).values(),
  ).map((address) => ({ address }));
}

function mailboxDomain(mailboxUserId: string): string | undefined {
  const atIndex = mailboxUserId.indexOf("@");
  return atIndex >= 0 ? mailboxUserId.slice(atIndex + 1).toLowerCase() : undefined;
}

function resolveMailRiskFlags(params: {
  account: { mailboxUserId: string };
  replyMode: "reply" | "replyAll";
  recipients: Array<{ address: string; name?: string }>;
}): string[] {
  const flags = new Set<string>();
  if (params.replyMode === "replyAll") {
    flags.add("reply_all");
  }
  const internalDomain = mailboxDomain(params.account.mailboxUserId);
  for (const recipient of params.recipients) {
    const [, domain] = recipient.address.toLowerCase().split("@");
    if (domain && internalDomain && domain !== internalDomain) {
      flags.add("external_recipient");
    }
  }
  return Array.from(flags).toSorted();
}

function parseMetadataApproverIds(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.approverTeamsUserIds;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function buildMailApprovalAction(params: {
  snapshot: M365MailReplySnapshot;
  previewChars: number;
}): ActionApprovalActionMetadata {
  return {
    kind: params.snapshot.kind,
    title: `Approve Outlook ${params.snapshot.replyMode === "replyAll" ? "reply-all" : "reply"}`,
    summary: params.snapshot.sourceSubject?.trim()
      ? params.snapshot.sourceSubject.trim()
      : `Mailbox ${params.snapshot.mailboxUserId}`,
    highRisk: params.snapshot.riskFlags.length > 0,
    facts: [
      { title: "Mailbox", value: params.snapshot.mailboxUserId },
      { title: "Mode", value: params.snapshot.replyMode },
      {
        title: "Recipients",
        value: params.snapshot.normalizedRecipients
          .map((recipient) => recipient.address)
          .join(", "),
      },
      {
        title: "Preview",
        value:
          params.snapshot.bodyMarkdown.length > params.previewChars
            ? `${params.snapshot.bodyMarkdown.slice(0, params.previewChars).trimEnd()}...`
            : params.snapshot.bodyMarkdown,
      },
    ],
    metadata: {
      approverTeamsUserIds: params.snapshot.approverTeamsUserIds,
      riskFlags: params.snapshot.riskFlags,
      mailboxUserId: params.snapshot.mailboxUserId,
      idempotencyKey: params.snapshot.idempotencyKey,
    },
  };
}

function buildMailReplyIdempotencyKey(params: {
  identityId: string;
  messageId: string;
  replyMode: "reply" | "replyAll";
  bodyMarkdown: string;
}): string {
  const seed = JSON.stringify({
    identityId: params.identityId,
    messageId: params.messageId,
    replyMode: params.replyMode,
    bodyMarkdown: params.bodyMarkdown.trim(),
  });
  return `m365-mail-${createHash("sha256").update(seed).digest("hex")}`;
}

function findExistingMailApproval(params: {
  taskFlow: ReturnType<OpenClawPluginApi["runtime"]["taskFlow"]["fromToolContext"]>;
  snapshotHash: string;
}) {
  for (const flow of params.taskFlow.list()) {
    const loaded = loadActionApprovalFlow<M365MailReplySnapshot>({
      taskFlow: params.taskFlow,
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      snapshotHash: params.snapshotHash,
    });
    if (!loaded.ok) {
      continue;
    }
    if (
      loaded.state.kind === "action_approval" &&
      (loaded.state.status === "pending" ||
        loaded.state.status === "claimed" ||
        loaded.state.status === "succeeded")
    ) {
      return {
        flowId: loaded.flow.flowId,
        expectedRevision: loaded.flow.revision,
        snapshotHash: loaded.snapshotHash,
      };
    }
  }
  return null;
}

async function editApprovalCardText(ctx: M365InteractiveContext, text: string): Promise<void> {
  await ctx.respond.editMessage({ text });
}

async function executeApprovedSnapshot(params: {
  api: OpenClawPluginApi;
  deps: M365ToolDeps;
  snapshot: M365ApprovalSnapshot;
}) {
  const config = await resolveM365RuntimeConfig(params.api, params.deps);
  const account = resolveM365RuntimeAccount({
    config,
    identityId: params.snapshot.identityId,
  });
  assertM365WriteAllowed({
    config,
    account,
    writeKind: "mail",
    targetId: params.snapshot.mailboxUserId,
  });
  if (params.snapshot.conversationId && params.snapshot.sourceReceivedAt) {
    const client = createM365JsonGraphClient({
      config,
      account,
      deps: params.deps,
    });
    const newerHumanReply = await hasOutlookHumanReplyAfter({
      client,
      account,
      conversationId: params.snapshot.conversationId,
      mailboxUserId: params.snapshot.mailboxUserId,
      sourceReceivedAt: params.snapshot.sourceReceivedAt,
    });
    if (newerHumanReply) {
      return {
        ok: false as const,
        blockedSummary: "A newer human reply landed in the thread before approval.",
      };
    }
    const sent = await sendOutlookReply({
      client,
      account,
      messageId: params.snapshot.messageId,
      replyMode: params.snapshot.replyMode,
      body: params.snapshot.bodyMarkdown,
    });
    return {
      ok: true as const,
      result: sent,
    };
  }

  const client = createM365JsonGraphClient({
    config,
    account,
    deps: params.deps,
  });
  const sent = await sendOutlookReply({
    client,
    account,
    messageId: params.snapshot.messageId,
    replyMode: params.snapshot.replyMode,
    body: params.snapshot.bodyMarkdown,
  });
  return {
    ok: true as const,
    result: sent,
  };
}

export async function queueM365MailReplyApproval(params: {
  api: OpenClawPluginApi;
  deps: M365ToolDeps;
  toolContext: OpenClawPluginToolContext;
  identityId: string;
  message: M365MailMessageDetails;
  bodyMarkdown: string;
  replyMode: "reply" | "replyAll";
}): Promise<ReturnType<typeof jsonResult>> {
  const config = await resolveM365RuntimeConfig(params.api, params.deps);
  const account = resolveM365RuntimeAccount({
    config,
    identityId: params.identityId,
  });
  assertM365WriteAllowed({
    config,
    account,
    writeKind: "mail",
    targetId: account.mailboxUserId,
  });
  const approverTeamsUserIds = resolveApproverTeamsUserIds({
    config,
  });
  if (approverTeamsUserIds.length === 0) {
    throw new Error("M365 mail approvals require explicit Teams approver ids.");
  }
  const normalizedRecipients =
    params.replyMode === "replyAll"
      ? normalizeRecipients([
          ...(params.message.from ? [params.message.from] : []),
          ...params.message.to,
          ...params.message.cc,
        ]).filter((recipient) => recipient.address !== account.mailboxUserId.toLowerCase())
      : normalizeRecipients(params.message.from ? [params.message.from] : []);
  const idempotencyKey = buildMailReplyIdempotencyKey({
    identityId: account.identityId,
    messageId: params.message.id,
    replyMode: params.replyMode,
    bodyMarkdown: params.bodyMarkdown,
  });
  const snapshot: M365MailReplySnapshot = {
    kind: "m365.mail.reply",
    accountId: account.accountId,
    identityId: account.identityId,
    mailboxUserId: account.mailboxUserId,
    messageId: params.message.id,
    ...(params.message.conversationId ? { conversationId: params.message.conversationId } : {}),
    ...(params.message.receivedAt ? { sourceReceivedAt: params.message.receivedAt } : {}),
    ...(params.message.subject ? { sourceSubject: params.message.subject } : {}),
    replyMode: params.replyMode,
    bodyMarkdown: params.bodyMarkdown,
    normalizedRecipients,
    riskFlags: resolveMailRiskFlags({
      account,
      replyMode: params.replyMode,
      recipients: normalizedRecipients,
    }),
    approverTeamsUserIds,
    idempotencyKey,
  };
  const action = buildMailApprovalAction({
    snapshot,
    previewChars: config.approval.previewChars,
  });
  const taskFlow = params.api.runtime.taskFlow.fromToolContext(params.toolContext);
  const snapshotHash = hashActionApprovalSnapshot(snapshot);
  const existing = findExistingMailApproval({
    taskFlow,
    snapshotHash,
  });
  if (existing) {
    return jsonResult({
      queued: true,
      deduped: true,
      flowId: existing.flowId,
      expectedRevision: existing.expectedRevision,
      snapshotHash: existing.snapshotHash,
      approverTeamsUserIds,
      riskFlags: snapshot.riskFlags,
    });
  }
  const created = createWaitingActionApprovalFlow({
    taskFlow,
    controllerId: "extensions/m365/mail-approval",
    goal: `Approve Outlook reply for ${account.mailboxUserId}`,
    currentStep: "queue-reply",
    waitingStep: "awaiting-approval",
    action,
    snapshot,
    expiresAt: (params.deps.now?.() ?? new Date()).getTime() + config.approval.timeoutMs,
  });
  const card = buildTeamsActionApprovalCard({
    namespace: M365_APPROVAL_NAMESPACE,
    ownerSessionKey: taskFlow.sessionKey,
    flowId: created.flow.flowId,
    expectedRevision: created.expectedRevision,
    snapshotHash: created.snapshotHash,
    action,
  });
  const deliverApprovalCard = params.deps.deliverApprovalCard ?? deliverTeamsActionApprovalCard;
  for (const approverId of approverTeamsUserIds) {
    await deliverApprovalCard({
      cfg: params.api.config,
      to: `user:${approverId}`,
      card,
      requesterSenderId: params.toolContext.requesterSenderId,
      sessionKey: params.toolContext.sessionKey,
      sessionId: params.toolContext.sessionId,
      agentId: params.toolContext.agentId,
    });
  }
  return jsonResult({
    queued: true,
    flowId: created.flow.flowId,
    expectedRevision: created.expectedRevision,
    snapshotHash: created.snapshotHash,
    approverTeamsUserIds,
    riskFlags: snapshot.riskFlags,
  });
}

export function registerM365ApprovalInteractiveHandler(
  api: OpenClawPluginApi,
  deps: M365ToolDeps = {},
): void {
  api.registerInteractiveHandler({
    channel: "msteams",
    namespace: M365_APPROVAL_NAMESPACE,
    handler: async (rawCtx: unknown) => {
      const ctx = rawCtx as M365InteractiveContext;
      const decoded = decodeActionApprovalInteractivePayload(ctx.interaction.payload);
      if (!decoded) {
        await ctx.respond.reply({ text: "This approval payload is invalid." });
        return { handled: true };
      }
      const taskFlow = api.runtime.taskFlow.bindSession({
        sessionKey: decoded.ownerSessionKey,
      });
      const loaded = loadActionApprovalFlow<M365ApprovalSnapshot>({
        taskFlow,
        flowId: decoded.flowId,
        expectedRevision: decoded.expectedRevision,
        snapshotHash: decoded.snapshotHash,
      });
      if (!loaded.ok) {
        await editApprovalCardText(ctx, `Approval could not be applied (${loaded.code}).`);
        return { handled: true };
      }
      const approverTeamsUserIds = parseMetadataApproverIds(
        loaded.state.action.metadata as Record<string, unknown> | undefined,
      );
      if (
        approverTeamsUserIds.length > 0 &&
        (!ctx.senderId || !approverTeamsUserIds.includes(ctx.senderId))
      ) {
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
        await editApprovalCardText(
          ctx,
          resolved.applied
            ? decoded.decision === "deny"
              ? "Denied."
              : "Revision requested."
            : `Approval could not be applied (${resolved.code}).`,
        );
        return { handled: true };
      }

      const claimed = claimActionApprovalFlow<M365ApprovalSnapshot>({
        taskFlow,
        flowId: decoded.flowId,
        expectedRevision: decoded.expectedRevision,
        snapshotHash: decoded.snapshotHash,
        actorId: ctx.senderId,
      });
      if (!claimed.applied) {
        await editApprovalCardText(
          ctx,
          claimed.code === "expired"
            ? "Approval expired."
            : `Approval could not be applied (${claimed.code}).`,
        );
        return { handled: true };
      }
      let executed: Awaited<ReturnType<typeof executeApprovedSnapshot>> | undefined;
      try {
        executed = await executeApprovedSnapshot({
          api,
          deps,
          snapshot: claimed.snapshot,
        });
      } catch (error) {
        const blockedSummary = error instanceof Error ? error.message : "Execution failed.";
        const failed = failClaimedActionApprovalFlow({
          taskFlow,
          flowId: claimed.flow.flowId,
          expectedRevision: claimed.flow.revision,
          snapshotHash: claimed.snapshotHash,
          actorId: ctx.senderId,
          blockedSummary,
        });
        await editApprovalCardText(
          ctx,
          failed.applied
            ? `Approval failed safely: ${blockedSummary}`
            : `Approval could not be applied (${failed.code}).`,
        );
        return { handled: true };
      }
      if (!executed.ok) {
        const failed = failClaimedActionApprovalFlow({
          taskFlow,
          flowId: claimed.flow.flowId,
          expectedRevision: claimed.flow.revision,
          snapshotHash: claimed.snapshotHash,
          actorId: ctx.senderId,
          blockedSummary: executed.blockedSummary,
        });
        await editApprovalCardText(
          ctx,
          failed.applied
            ? `Approval failed safely: ${executed.blockedSummary}`
            : `Approval could not be applied (${failed.code}).`,
        );
        return { handled: true };
      }
      const finished = finishClaimedActionApprovalFlow({
        taskFlow,
        flowId: claimed.flow.flowId,
        expectedRevision: claimed.flow.revision,
        snapshotHash: claimed.snapshotHash,
        actorId: ctx.senderId,
        result: executed.result as never,
      });
      await editApprovalCardText(
        ctx,
        finished.applied
          ? "Approved and executed."
          : `Approval could not be applied (${finished.code}).`,
      );
      return { handled: true };
    },
  } satisfies PluginInteractiveRegistration<unknown, "msteams">);
}
