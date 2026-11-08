import * as Checks from "../compiled/protocol.generated/validators-workers.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";
import { WorkerComputerParamsSchema } from "../schema/worker-computer.js";
import { checkWorkerProtocolJson } from "../schema/worker-protocol-primitives.js";

export const validateConnectParams = createProtocolValidator(
  S.ConnectParamsSchema,
  Checks.isConnectParams,
);
export const validateWorkerAdmissionHandshake = createProtocolValidator(
  S.WorkerAdmissionHandshakeSchema,
  Checks.isWorkerAdmissionHandshake,
);
export const validateWorkerConnectRequestFrame = createProtocolValidator(
  S.WorkerConnectRequestFrameSchema,
  Checks.isWorkerConnectRequestFrame,
);
export const validateWorkerHeartbeatParams = createProtocolValidator(
  S.WorkerHeartbeatParamsSchema,
  Checks.isWorkerHeartbeatParams,
);
export const validateWorkerSessionsSpawnParams = createProtocolValidator(
  S.WorkerSessionsSpawnParamsSchema,
  Checks.isWorkerSessionsSpawnParams,
);
export const validateWorkerSessionsSendParams = createProtocolValidator(
  S.WorkerSessionsSendParamsSchema,
  Checks.isWorkerSessionsSendParams,
);
export const validateWorkerPortalParams = createProtocolValidator(
  S.WorkerPortalParamsSchema,
  Checks.isWorkerPortalParams,
);
export const validateWorkerPresenceParams = createProtocolValidator(
  S.WorkerPresenceParamsSchema,
  Checks.isWorkerPresenceParams,
);
export const validateWorkerComputerParams = createProtocolValidator(
  WorkerComputerParamsSchema,
  Checks.isWorkerComputerParams,
);
export const validateWorkerTranscriptCommitParams = createProtocolValidator(
  S.WorkerTranscriptCommitParamsSchema,
  Checks.isWorkerTranscriptCommitParams,
  checkWorkerProtocolJson,
);
export const validateWorkerLiveEventParams = createProtocolValidator(
  S.WorkerLiveEventParamsSchema,
  Checks.isWorkerLiveEventParams,
  checkWorkerProtocolJson,
);
export const validateGatewaySuspendPrepareParams = createProtocolValidator(
  S.GatewaySuspendPrepareParamsSchema,
  Checks.isGatewaySuspendPrepareParams,
);
export const validateGatewaySuspendPrepareResult = createProtocolValidator(
  S.GatewaySuspendPrepareResultSchema,
  Checks.isGatewaySuspendPrepareResult,
);
export const validateGatewaySuspendStatusParams = createProtocolValidator(
  S.GatewaySuspendStatusParamsSchema,
  Checks.isGatewaySuspendStatusParams,
);
export const validateGatewaySuspendStatusResult = createProtocolValidator(
  S.GatewaySuspendStatusResultSchema,
  Checks.isGatewaySuspendStatusResult,
);
export const validateGatewaySuspendResumeParams = createProtocolValidator(
  S.GatewaySuspendResumeParamsSchema,
  Checks.isGatewaySuspendResumeParams,
);
export const validateGatewaySuspendHandoffParams = createProtocolValidator(
  S.GatewaySuspendHandoffParamsSchema,
  Checks.isGatewaySuspendHandoffParams,
);
export const validateRequestFrame = createProtocolValidator(
  S.RequestFrameSchema,
  Checks.isRequestFrame,
);
export const validateNodePairListParams = createProtocolValidator(
  S.NodePairListParamsSchema,
  Checks.isNodePairListParams,
);
export const validateNodePairApproveParams = createProtocolValidator(
  S.NodePairApproveParamsSchema,
  Checks.isNodePairApproveParams,
);
export const validateNodePairRejectParams = createProtocolValidator(
  S.NodePairRejectParamsSchema,
  Checks.isNodePairRejectParams,
);
export const validateNodePairRemoveParams = createProtocolValidator(
  S.NodePairRemoveParamsSchema,
  Checks.isNodePairRemoveParams,
);
export const validateNodeRenameParams = createProtocolValidator(
  S.NodeRenameParamsSchema,
  Checks.isNodeRenameParams,
);
export const validateNodeListParams = createProtocolValidator(
  S.NodeListParamsSchema,
  Checks.isNodeListParams,
);
export const validateNodePluginToolsUpdateParams = createProtocolValidator(
  S.NodePluginToolsUpdateParamsSchema,
  Checks.isNodePluginToolsUpdateParams,
);
export const validateNodeSkillsUpdateParams = createProtocolValidator(
  S.NodeSkillsUpdateParamsSchema,
  Checks.isNodeSkillsUpdateParams,
);
export const validateWorkerDesktopObserveParams = createProtocolValidator(
  S.WorkerDesktopObserveParamsSchema,
  Checks.isWorkerDesktopObserveParams,
);
export const validateWorkerDesktopObserveResult = createProtocolValidator(
  S.WorkerDesktopObserveResultSchema,
  Checks.isWorkerDesktopObserveResult,
);
export const validateWorkerDesktopLaunchParams = createProtocolValidator(
  S.WorkerDesktopLaunchParamsSchema,
  Checks.isWorkerDesktopLaunchParams,
);
export const validateWorkerDesktopLaunchResult = createProtocolValidator(
  S.WorkerDesktopLaunchResultSchema,
  Checks.isWorkerDesktopLaunchResult,
);
export const validateNodePendingAckParams = createProtocolValidator(
  S.NodePendingAckParamsSchema,
  Checks.isNodePendingAckParams,
);
export const validateNodeDescribeParams = createProtocolValidator(
  S.NodeDescribeParamsSchema,
  Checks.isNodeDescribeParams,
);
export const validateNodeInvokeParams = createProtocolValidator(
  S.NodeInvokeParamsSchema,
  Checks.isNodeInvokeParams,
);
export const validateNodeInvokeResultParams = createProtocolValidator(
  S.NodeInvokeResultParamsSchema,
  Checks.isNodeInvokeResultParams,
);
export const validateNodeInvokeProgressParams = createProtocolValidator(
  S.NodeInvokeProgressParamsSchema,
  Checks.isNodeInvokeProgressParams,
);
export const validateNodeEventParams = createProtocolValidator(
  S.NodeEventParamsSchema,
  Checks.isNodeEventParams,
);
export const validateNodePresenceActivityPayload = createProtocolValidator(
  S.NodePresenceActivityPayloadSchema,
  Checks.isNodePresenceActivityPayload,
);
export const validateNodeHostStatsPayload = createProtocolValidator(
  S.NodeHostStatsPayloadSchema,
  Checks.isNodeHostStatsPayload,
);
export const validateNodePendingDrainParams = createProtocolValidator(
  S.NodePendingDrainParamsSchema,
  Checks.isNodePendingDrainParams,
);
export const validateNodePendingEnqueueParams = createProtocolValidator(
  S.NodePendingEnqueueParamsSchema,
  Checks.isNodePendingEnqueueParams,
);
export const validateDevicePairListParams = createProtocolValidator(
  S.DevicePairListParamsSchema,
  Checks.isDevicePairListParams,
);
export const validateDevicePairApproveParams = createProtocolValidator(
  S.DevicePairApproveParamsSchema,
  Checks.isDevicePairApproveParams,
);
export const validateDevicePairRejectParams = createProtocolValidator(
  S.DevicePairRejectParamsSchema,
  Checks.isDevicePairRejectParams,
);
export const validateDevicePairRemoveParams = createProtocolValidator(
  S.DevicePairRemoveParamsSchema,
  Checks.isDevicePairRemoveParams,
);
export const validateDevicePairSetupCodeParams = createProtocolValidator(
  S.DevicePairSetupCodeParamsSchema,
  Checks.isDevicePairSetupCodeParams,
);
export const validateDevicePairSetupStatusParams = createProtocolValidator(
  S.DevicePairSetupStatusParamsSchema,
  Checks.isDevicePairSetupStatusParams,
);
export const validateDevicePairRenameParams = createProtocolValidator(
  S.DevicePairRenameParamsSchema,
  Checks.isDevicePairRenameParams,
);
export const validateDeviceTokenRotateParams = createProtocolValidator(
  S.DeviceTokenRotateParamsSchema,
  Checks.isDeviceTokenRotateParams,
);
export const validateDeviceTokenRevokeParams = createProtocolValidator(
  S.DeviceTokenRevokeParamsSchema,
  Checks.isDeviceTokenRevokeParams,
);
export const validateExecApprovalsNodeGetParams = createProtocolValidator(
  S.ExecApprovalsNodeGetParamsSchema,
  Checks.isExecApprovalsNodeGetParams,
);
export const validateExecApprovalsNodeSetParams = createProtocolValidator(
  S.ExecApprovalsNodeSetParamsSchema,
  Checks.isExecApprovalsNodeSetParams,
);
export const validateExecApprovalsNodeSnapshot = createProtocolValidator(
  S.ExecApprovalsNodeSnapshotSchema,
  Checks.isExecApprovalsNodeSnapshot,
);
