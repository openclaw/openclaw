import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import { editMessageWhatsApp, sendReactionWhatsApp, unsendMessageWhatsApp } from "./send.js";

export const whatsAppActionRuntime = {
  resolveAuthorizedWhatsAppOutboundTarget,
  editMessageWhatsApp,
  sendReactionWhatsApp,
  unsendMessageWhatsApp,
};

class WhatsAppToolInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function readEditMessageText(params: Record<string, unknown>): string {
  const text =
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true });
  if (text === undefined) {
    throw new WhatsAppToolInputError("WhatsApp message edit text is required.");
  }
  if (!text.trim()) {
    throw new WhatsAppToolInputError("WhatsApp message edit text cannot be empty.");
  }
  return text;
}

export async function handleWhatsAppAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const whatsAppConfig = cfg.channels?.whatsapp;
  const isActionEnabled = createActionGate(whatsAppConfig?.actions);

  if (action === "react") {
    const accountId = readStringParam(params, "accountId");
    if (!whatsAppConfig) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    if (!isActionEnabled("reactions")) {
      throw new Error("WhatsApp reactions are disabled.");
    }
    const reactionLevelInfo = resolveWhatsAppReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      throw new Error(
        `WhatsApp agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
          `Set channels.whatsapp.reactionLevel to "minimal" or "extensive" to enable.`,
      );
    }
    const chatJid = readStringParam(params, "chatJid", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a WhatsApp reaction.",
    });
    const participant = readStringParam(params, "participant");
    const fromMeRaw = params.fromMe;
    const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : undefined;

    // Resolve account + allowFrom via shared account logic so auth and routing stay aligned.
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: "reaction",
    });

    const resolvedEmoji = remove ? "" : emoji;
    await whatsAppActionRuntime.sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
      verbose: false,
      fromMe,
      participant: participant ?? undefined,
      accountId: resolved.accountId,
      cfg,
    });
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "edit" || action === "delete" || action === "unsend") {
    const accountId = readStringParam(params, "accountId");
    if (!whatsAppConfig) {
      throw new Error(`WhatsApp message ${action} is disabled.`);
    }
    if (!isActionEnabled("sendMessage")) {
      throw new Error(`WhatsApp message ${action} is disabled.`);
    }
    const chatJid =
      readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true });
    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const editText = readEditMessageText(params);
      const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
        cfg,
        chatJid,
        accountId,
        actionLabel: `message ${action}`,
      });
      const result = await whatsAppActionRuntime.editMessageWhatsApp(
        resolved.to,
        messageId,
        editText,
        {
          verbose: false,
          accountId: resolved.accountId,
          cfg,
        },
      );
      return jsonResult({ ok: true, edited: true, messageId: result.messageId });
    }
    const messageId = readStringParam(params, "messageId", { required: true });
    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid,
      accountId,
      actionLabel: `message ${action}`,
    });
    await whatsAppActionRuntime.unsendMessageWhatsApp(resolved.to, messageId, {
      verbose: false,
      accountId: resolved.accountId,
      cfg,
    });
    if (action === "delete") {
      return jsonResult({ ok: true, deleted: true, messageId });
    }
    return jsonResult({ ok: true, unsent: true, messageId });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
