import { createSubsystemLogger } from "../../../../src/logging/subsystem.js";
const whatsappLog = createSubsystemLogger("gateway/channels/whatsapp");
const whatsappInboundLog = whatsappLog.child("inbound");
const whatsappOutboundLog = whatsappLog.child("outbound");
const whatsappHeartbeatLog = whatsappLog.child("heartbeat");
export {
  whatsappHeartbeatLog,
  whatsappInboundLog,
  whatsappLog,
  whatsappOutboundLog
};
