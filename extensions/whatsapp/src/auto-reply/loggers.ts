import { createSubsystemLogger, defaultRuntime } from "openclaw/plugin-sdk/runtime-env";

export const whatsappLog = createSubsystemLogger("gateway/channels/whatsapp");
export const whatsappInboundLog = whatsappLog.child("inbound");
export const whatsappOutboundLog = whatsappLog.child("outbound");
export const whatsappHeartbeatLog = whatsappLog.child("heartbeat");

export function logWhatsAppVerbose(enabled: boolean | undefined, message: string): void {
  if (enabled) {
    defaultRuntime.log(message);
  }
}
