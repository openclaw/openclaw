import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { z } from "zod";
import { requestA2aPeer, resolveA2aOutboundPeer, sendA2aChannelText } from "./outbound.js";
import { extractA2aMessageText } from "./protocol.js";
import {
  a2aPeerScope,
  currentReceiptGeneration,
  getTaskReceipt,
  pruneTaskReceipts,
  recordAcceptedSend,
} from "./task-receipts.js";

export { clearA2aTaskReadReceipts } from "./task-receipts.js";

const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({
    // Conforming peers may report a state this build does not enumerate (for example
    // TASK_STATE_UNSPECIFIED); the reader normalizes any value and treats only the known
    // terminal states as terminal instead of rejecting the whole task.
    state: z.string().min(1),
    message: z.object({ parts: z.array(z.unknown()) }).optional(),
  }),
  artifacts: z.array(z.object({ parts: z.array(z.unknown()) })).optional(),
});

function sourceKey(ctx: ChannelMessageActionContext): string | undefined {
  return ctx.agentId && ctx.sessionKey && ctx.sessionId
    ? JSON.stringify([ctx.agentId, ctx.sessionKey, ctx.sessionId])
    : undefined;
}

function peerScope(ctx: ChannelMessageActionContext, to: string): string {
  const { accountId, peerName, peer } = resolveA2aOutboundPeer({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    to,
  });
  return a2aPeerScope({ accountId, peerName, url: peer.url, outboundToken: peer.outboundToken });
}

export async function handleA2aTaskAction(ctx: ChannelMessageActionContext) {
  const to =
    readStringParam(ctx.params, "to") ?? readStringParam(ctx.params, "target", { required: true });
  if (!to) {
    throw new Error("A2A peer target is required");
  }
  if (ctx.action === "send") {
    const text = readStringParam(ctx.params, "message", { required: true });
    if (!text) {
      throw new Error("A2A task text is required");
    }
    const source = sourceKey(ctx);
    const generation = currentReceiptGeneration();
    // Resolve before I/O; later configuration cannot rebind this accepted task.
    const scope = peerScope(ctx, to);
    if (ctx.dryRun) {
      return jsonResult({ to, dryRun: true, readAvailable: false });
    }
    const sent = await sendA2aChannelText({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      to,
      text,
      // This path mints the read receipt itself once the peer's task ID is known, so the
      // plain send surface must not revoke the collision evidence first.
      deferReceiptReconcile: true,
      assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    });
    // Any accepted send reconciles the receipt store: a peer that reuses a task ID for
    // another source (or a send that cannot mint a receipt at all) must not leave the
    // earlier session able to read the replacement task. Every send to a peer shares one
    // remote context, so the context check alone cannot separate them.
    const readAvailable = recordAcceptedSend({
      peerScope: scope,
      taskId: sent.taskId,
      source,
      contextId: sent.contextId,
      generation,
    });
    return jsonResult({ ...sent, readAvailable });
  }
  if (ctx.action !== "read") {
    throw new Error(`Unsupported A2A action: ${ctx.action}`);
  }
  const taskId = readStringParam(ctx.params, "messageId", { required: true });
  if (!taskId) {
    throw new Error("A2A read requires the remote task ID as messageId");
  }
  const assertAuthority = captureChannelReadAuthority();
  const scope = peerScope(ctx, to);
  pruneTaskReceipts();
  const receipt = getTaskReceipt(scope, taskId);
  const directOperator = ctx.conversationReadOrigin === "direct-operator";
  const assertCurrent = () => {
    assertAuthority?.();
    ctx.assertDirectAdapterHandoff?.();
    pruneTaskReceipts();
    if (
      !directOperator &&
      (!assertAuthority ||
        !receipt ||
        receipt.source !== sourceKey(ctx) ||
        getTaskReceipt(scope, taskId) !== receipt)
    ) {
      throw new Error(
        "A2A task read requires a SendMessage receipt from this exact agent/session incarnation and configured peer. Missing, expired or restarted receipts cannot be recovered from a task ID alone; ask an operator to reconcile, do not resend the task.",
      );
    }
  };
  assertCurrent();
  if (ctx.dryRun) {
    return jsonResult({ to, taskId, dryRun: true });
  }
  const response = await requestA2aPeer({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    to,
    method: "GetTask",
    rpcParams: { id: taskId },
    assertCurrent,
  });
  assertCurrent();
  const task = TaskSchema.safeParse(response.result);
  if (
    !task.success ||
    task.data.id !== taskId ||
    (!directOperator && receipt && task.data.contextId !== receipt.contextId)
  ) {
    throw new Error("A2A peer returned an invalid or mismatched task/context");
  }
  const state = task.data.status.state
    .replace(/^TASK_STATE_/, "")
    .replaceAll("-", "_")
    .toLowerCase();
  return jsonResult({
    to,
    taskId: task.data.id,
    contextId: task.data.contextId,
    state,
    terminal: ["completed", "failed", "canceled", "rejected"].includes(state),
    inputRequired: state === "input_required" || state === "auth_required",
    text:
      extractA2aMessageText(task.data.artifacts?.flatMap((artifact) => artifact.parts) ?? []) ?? "",
    ...(task.data.status.message
      ? { statusText: extractA2aMessageText(task.data.status.message.parts) ?? "" }
      : {}),
  });
}
