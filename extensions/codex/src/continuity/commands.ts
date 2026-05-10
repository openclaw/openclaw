import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { getCodexContinuityBridge } from "./bridge.js";

export async function handleCodexContinuityCommand(
  ctx: PluginCommandContext,
  subcommand: string,
  args: string[],
): Promise<PluginCommandResult | undefined> {
  const bridge = getCodexContinuityBridge();
  if (!bridge) {
    return undefined;
  }
  if (subcommand === "status") {
    if (args.length > 0) {
      return { text: "Usage: /codex status" };
    }
    return { text: await bridge.formatStatusCommand() };
  }
  if (subcommand === "threads") {
    return { text: await bridge.formatThreadsCommand() };
  }
  if (subcommand === "watch") {
    const [threadId] = args;
    if (!threadId) {
      const snapshot = await bridge.snapshot();
      const candidate = snapshot.activeThreads[0] ?? snapshot.latestThread;
      if (!candidate) {
        return { text: "No Codex thread is available to watch. Try /codex threads first." };
      }
      const watch = await bridge.registerWatch({
        threadId: candidate.id,
        notifyTarget: ctx.senderId ?? ctx.from,
        notifyChannel: ctx.channel,
        notifyAccountId: ctx.accountId,
        notifyThreadId: ctx.messageThreadId,
        createdBy: commandRequester(ctx),
      });
      return { text: `Watching Codex thread ${candidate.id} until ${watch.expiresAt}.` };
    }
    const watch = await bridge.registerWatch({
      threadId,
      notifyTarget: ctx.senderId ?? ctx.from,
      notifyChannel: ctx.channel,
      notifyAccountId: ctx.accountId,
      notifyThreadId: ctx.messageThreadId,
      createdBy: commandRequester(ctx),
    });
    return { text: `Watching Codex thread ${threadId} until ${watch.expiresAt}.` };
  }
  if (subcommand === "handoff") {
    const [threadId] = args;
    const brief = await bridge.handoff(threadId);
    return { text: brief.markdown };
  }
  if (subcommand === "goal") {
    const prompt = args.join(" ").trim();
    const decision = await bridge.submitWriteRequest({
      action: "goal",
      prompt,
      requestedBySenderId: ctx.senderId,
      provenance: {
        requestedBy: commandRequester(ctx),
        requestId: ctx.commandBody,
        sourceMessageId: ctx.commandBody,
        confirmed: false,
        riskClass: "medium",
        createdAt: new Date().toISOString(),
      },
    });
    if (!decision.ok) {
      return {
        text: `Codex write rejected: ${decision.message}\nReasons: ${decision.reasons.join("; ")}`,
      };
    }
    return { text: `Codex goal accepted for thread ${decision.threadId}.` };
  }
  if (subcommand === "bridge" || subcommand === "continuity") {
    const [next = "status", ...rest] = args;
    return handleCodexContinuityCommand(ctx, next.toLowerCase(), rest);
  }
  return undefined;
}

function commandRequester(ctx: PluginCommandContext): string {
  return `${ctx.channel}:${ctx.senderId ?? ctx.from ?? "unknown"}`;
}
