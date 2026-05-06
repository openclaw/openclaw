import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";
import { sendLocationWhatsApp, sendReactionWhatsApp } from "./send.js";

export const whatsAppActionRuntime = {
  resolveAuthorizedWhatsAppOutboundTarget,
  sendReactionWhatsApp,
  sendLocationWhatsApp,
};

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

  if (action === "location") {
    const accountId = readStringParam(params, "accountId");
    if (!whatsAppConfig) {
      throw new Error("WhatsApp location sends are disabled.");
    }
    const to =
      readStringParam(params, "to") ?? readStringParam(params, "chatJid", { required: true });
    const latitude = readNumberParam(params, "latitude", { required: true });
    const longitude = readNumberParam(params, "longitude", { required: true });
    if (latitude == null || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error("latitude must be a finite number between -90 and 90.");
    }
    if (longitude == null || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error("longitude must be a finite number between -180 and 180.");
    }
    const locationName = readStringParam(params, "locationName");
    const locationAddress = readStringParam(params, "locationAddress");
    const accuracyInMeters = readNumberParam(params, "accuracyInMeters", { strict: true });

    const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
      cfg,
      chatJid: to,
      accountId,
      actionLabel: "location",
    });

    const sent = await whatsAppActionRuntime.sendLocationWhatsApp(
      resolved.to,
      {
        latitude,
        longitude,
        locationName: locationName ?? undefined,
        locationAddress: locationAddress ?? undefined,
        accuracyInMeters: accuracyInMeters ?? undefined,
      },
      {
        verbose: false,
        accountId: resolved.accountId,
        cfg,
      },
    );
    return jsonResult({ ok: true, messageId: sent.messageId, toJid: sent.toJid });
  }

  throw new Error(`Unsupported WhatsApp action: ${action}`);
}
