import type { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";

function isExplicitWhatsAppCommandTurn(params: {
  commandTurn?: FinalizedMsgContext["CommandTurn"];
  commandSource?: "native" | "text";
  commandAuthorized?: boolean;
}): boolean {
  const isNativeCommandTurn = params.commandTurn?.kind === "native";
  const isNativeCommandSource = params.commandSource === "native";
  const isAuthorizedTextCommandTurn =
    params.commandTurn?.kind === "text-slash" ? params.commandTurn.authorized : false;
  const isAuthorizedTextCommandSource =
    params.commandSource === "text" ? Boolean(params.commandAuthorized) : false;

  return (
    isNativeCommandTurn ||
    isNativeCommandSource ||
    isAuthorizedTextCommandTurn ||
    isAuthorizedTextCommandSource
  );
}

export function resolveWhatsAppTypingStartPolicy(params: {
  configuredTypingMode?: NonNullable<ReturnType<typeof resolveAgentConfig>>["typingMode"];
  chatType?: string;
  commandTurn?: FinalizedMsgContext["CommandTurn"];
  commandSource?: "native" | "text";
  commandAuthorized?: boolean;
  wasMentioned?: boolean;
}): "visible_delivery" | undefined {
  if (
    params.configuredTypingMode !== undefined ||
    params.chatType !== "group" ||
    params.wasMentioned === true
  ) {
    return undefined;
  }
  return isExplicitWhatsAppCommandTurn(params) ? undefined : "visible_delivery";
}
