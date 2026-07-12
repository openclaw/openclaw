// Whatsapp plugin module exposes live connection controllers through the channel runtime.
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { WhatsAppConnectionController } from "./connection-controller.js";
import { getOptionalWhatsAppRuntime } from "./runtime.js";

export const WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY = "connection-controller";

export type WhatsAppConnectionControllerHandle = Pick<
  WhatsAppConnectionController,
  "getActiveListener" | "getCurrentSock" | "getSelfIdentity"
>;

export function getWhatsAppConnectionController(
  accountId: string,
): WhatsAppConnectionControllerHandle | null {
  const context = getChannelRuntimeContext({
    channelRuntime: getOptionalWhatsAppRuntime()?.channel,
    channelId: "whatsapp",
    accountId,
    capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
  });
  return (context as WhatsAppConnectionControllerHandle | undefined) ?? null;
}
