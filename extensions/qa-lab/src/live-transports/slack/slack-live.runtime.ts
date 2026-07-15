// QA Lab Slack scenario support and stable test surface.
import { resolveSlackApprovalCheckpointConfig } from "./slack-live.approval-checkpoint.js";
import {
  matchesSlackApprovalPromptText,
  matchesSlackApprovalResolvedUpdate,
  resolveApprovalDecision,
} from "./slack-live.approvals.js";
import {
  buildCodexApprovalInstruction,
  readAcceptedAgentRunId,
  waitForSlackReaction,
  assertCodexApprovalTranscriptSucceeded,
  findPendingCodexPluginApprovalRecord,
  quiesceCodexApprovalAgentRun,
  resolveCodexFileApprovalTargetPath,
} from "./slack-live.codex-approval.js";
import {
  resolveSlackQaRuntimeEnv,
  parseSlackQaCredentialPayload,
  buildSlackQaConfig,
} from "./slack-live.config.js";
import {
  assertSlackCodexApprovalModelSupported,
  resolveSlackQaSutAccountId,
} from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
  waitForSlackChannelStable,
  isSlackChannelReadyForQa,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
} from "./slack-live.message-observations.js";
import {
  getSlackIdentity,
  sendSlackChannelMessage,
  listSlackMessages,
  listSlackThreadMessages,
  collectSlackBlockText,
  collectSlackActionValues,
  parseSlackNativeApprovalAction,
  collectSlackButtonLabels,
  buildSlackApprovalCheckpointMessage,
  extractSlackNativeApprovalId,
  waitForSlackStoredMessage,
  runSlackTableInvalidBlocksFallbackScenario,
} from "./slack-live.observations.js";
import { SLACK_QA_STANDARD_SCENARIO_IDS, findScenario } from "./slack-live.scenarios.js";

const testing = {
  assertSlackCodexApprovalModelSupported,
  assertCodexApprovalTranscriptSucceeded,
  buildCodexApprovalInstruction,
  buildSlackInvalidBlocksTableProbe,
  buildSlackApprovalCheckpointMessage,
  buildSlackQaConfig,
  collectSlackActionValues,
  collectSlackButtonLabels,
  collectSlackBlockText,
  extractSlackNativeApprovalId,
  findPendingCodexPluginApprovalRecord,
  findScenario,
  getSlackIdentity,
  isSlackChannelReadyForQa,
  matchesSlackApprovalResolvedUpdate,
  matchesSlackApprovalPromptText,
  observeSlackScenarioMessages,
  parseSlackNativeApprovalAction,
  parseSlackQaCredentialPayload,
  quiesceCodexApprovalAgentRun,
  readAcceptedAgentRunId,
  resolveCodexFileApprovalTargetPath,
  resolveSlackChannelReadySince,
  resolveSlackQaReadyTimeoutMs,
  resolveSlackApprovalCheckpointConfig,
  resolveApprovalDecision,
  resolveSlackQaSutAccountId,
  resolveSlackQaRuntimeEnv,
  runSlackTableInvalidBlocksFallbackScenario,
  sendSlackChannelMessage,
  listSlackMessages,
  listSlackThreadMessages,
  SLACK_QA_STANDARD_SCENARIO_IDS,
  waitForSlackStoredMessage,
  waitForSlackNoReply,
  waitForSlackReaction,
  waitForSlackChannelStable,
};
export { testing as __testing };
