// QA Lab plugin module implements WhatsApp scenario support helpers.
import { fingerprintQaCredentialId } from "../../qa-credentials-fingerprint.runtime.js";
import {
  formatWhatsAppApprovalWaitDiagnostics,
  matchesWhatsAppApprovalResolvedText,
  runWhatsAppApprovalScenario,
} from "./whatsapp-live.approvals.js";
import {
  buildWhatsAppQaConfig,
  parseWhatsAppQaCredentialPayload,
  resolveWhatsAppMetadataRedaction,
  resolveWhatsAppQaRuntimeEnv,
} from "./whatsapp-live.config.js";
import {
  WHATSAPP_QA_SCENARIO_POSTURES,
  resolveWhatsAppQaMessageTargets,
} from "./whatsapp-live.contracts.js";
import {
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  dedupeWhatsAppMessagesById,
  findUnexpectedWhatsAppNoReplyMessage,
  formatWhatsAppBatchMessageDiagnostics,
  formatWhatsAppScenarioWaitDiagnostics,
  isTransientWhatsAppQaDriverError,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
} from "./whatsapp-live.operations.js";
import {
  WHATSAPP_QA_STANDARD_SCENARIO_IDS,
  buildWhatsAppQaMockAuthAgentIds,
  findScenarios,
} from "./whatsapp-live.scenarios.js";
import {
  assertSafeArchiveEntries,
  isWhatsAppChannelReady,
  unpackWhatsAppAuthArchive,
  waitForWhatsAppChannelStable,
} from "./whatsapp-live.setup.js";

const testing = {
  assertSafeArchiveEntries,
  buildWhatsAppQaConfig,
  buildWhatsAppQaMockAuthAgentIds,
  callWhatsAppGatewayMessageAction,
  callWhatsAppGatewayPoll,
  callWhatsAppGatewaySend,
  findScenarios,
  findUnexpectedWhatsAppNoReplyMessage,
  formatWhatsAppApprovalWaitDiagnostics,
  formatWhatsAppBatchMessageDiagnostics,
  dedupeWhatsAppMessagesById,
  fingerprintWhatsAppCredentialId: fingerprintQaCredentialId,
  formatWhatsAppScenarioWaitDiagnostics,
  isWhatsAppChannelReady,
  isTransientWhatsAppQaDriverError,
  matchesWhatsAppApprovalResolvedText,
  parseWhatsAppQaCredentialPayload,
  runWhatsAppApprovalScenario,
  runWhatsAppStructuredInboundChecks,
  waitForScenarioObservedMessage,
  waitForWhatsAppChannelStable,
  resolveWhatsAppQaMessageTargets,
  resolveWhatsAppQaRuntimeEnv,
  resolveWhatsAppMetadataRedaction,
  unpackWhatsAppAuthArchive,
  WHATSAPP_QA_STANDARD_SCENARIO_IDS,
  WHATSAPP_QA_SCENARIO_POSTURES,
};
export { testing as __testing };
