import type { FaceTimeCallStatusEvent, AuthenticatedFaceTimeOwner } from "./call-events.js";
import { FaceTimeCallInstance } from "./call-lifecycle.js";
import type { HelperActionResult } from "./helper-results.js";
import type { FaceTimeHelperPeer } from "./helper-rpc.js";
import type { FaceTimeHelperSupervisorStatus } from "./helper-supervisor.js";
import type { FaceTimeDialMode, PendingFaceTimeDial } from "./outbound-call.js";
import type { FaceTimeTalkDriver } from "./talk-driver.js";
import type { FaceTimeTalkEventSummary } from "./talk-events-summary.js";

export class ActiveFaceTimeCall extends FaceTimeCallInstance {
  readonly carrierCallUUIDs: Set<string>;
  readonly retiredCarrierCallUUIDs = new Set<string>();
  carrierCallUUID: string;
  readonly carrierPeers = new Map<number, FaceTimeHelperPeer>();
  readonly senderId: string;
  readonly senderIsOwner: true = true;
  handle?: string;
  callStatus?: number;
  isSendingAudio?: boolean;
  isSendingTransmission?: boolean;
  isUplinkMuted?: boolean;
  isSendingVideo?: boolean;
  conversationUUID?: string;
  conversationGroupUUID?: string;
  conversationAudioEnabled?: boolean;
  conversationVideoEnabled?: boolean;
  conversationAVMode?: number;
  conversationResolvedAudioVideoMode?: number;
  localMeterLevel?: number;
  remoteMeterLevel?: number;
  maxLocalMeterLevel?: number;
  maxRemoteMeterLevel?: number;
  audioReady = false;
  audioTransport?: {
    captureBinary: string;
    feedDevice: string;
    microphoneDevice: string;
    processInputVerified: boolean;
    processOutputSuppressed: boolean;
  };
  lastHelperAction?: HelperActionResult;
  lastRoutingError?: string;
  audioRouting?: Promise<void>;
  talk?: FaceTimeTalkDriver;
  talkStarting?: Promise<void>;
  talkActivation?: Promise<void>;
  carrierHangupPending?: boolean;
  carrierHangupRetryTimer?: NodeJS.Timeout;
  carrierHangupAttempt?: Promise<boolean>;
  readonly callUUID: string;

  constructor(params: {
    callUUID: string;
    phase: "ringing" | "active";
    owner: AuthenticatedFaceTimeOwner;
    handle?: string;
    peer?: FaceTimeHelperPeer;
  }) {
    super(params.callUUID, params.phase);
    this.callUUID = params.callUUID;
    this.carrierCallUUID = params.callUUID;
    this.carrierCallUUIDs = new Set([params.callUUID]);
    this.senderId = params.owner.senderId;
    this.handle = params.handle;
    if (params.peer) {
      this.carrierPeers.set(params.peer.processId, params.peer);
    }
  }

  promoteCarrierCallUUID(callUUID: string): void {
    if (callUUID !== this.carrierCallUUID) {
      this.retiredCarrierCallUUIDs.add(this.carrierCallUUID);
      this.retiredCarrierCallUUIDs.delete(callUUID);
    }
    this.carrierCallUUIDs.add(callUUID);
    this.carrierCallUUID = callUUID;
  }
}

export type FaceTimeRuntimeStatus = {
  enabled: true;
  helperConnected: boolean;
  helperProtocol: {
    version: 1;
    authentication: "mutual-hmac-sha256-v1";
    eventIntegrity: "epoch-sequence-hmac-v1";
    statusClassifier: "explicit-ended-tu-call-status-v1";
    transportClassifier: "tu-provider-v1";
  };
  helperTargets: FaceTimeHelperSupervisorStatus;
  driverInstallPending: boolean;
  driverInstall: {
    phase: "idle" | "installing" | "succeeded" | "failed";
    startedAt?: string;
    finishedAt?: string;
    changed?: boolean;
    error?: string;
  };
  processOutputSuppressed: boolean;
  outboundCallPending?: {
    dialID: string;
    delivery: PendingFaceTimeDial["delivery"];
    handle: string;
    mode: FaceTimeDialMode;
    requestedAt: string;
    proxyIdentifier?: string;
  };
  calls: Array<{
    callUUID: string;
    generation: number;
    phase: ActiveFaceTimeCall["phase"];
    carrierMode: ActiveFaceTimeCall["carrierMode"];
    modelMediaMode: ActiveFaceTimeCall["modelMediaMode"];
    handle?: string;
    callStatus?: number;
    isSendingAudio?: boolean;
    isSendingTransmission?: boolean;
    isUplinkMuted?: boolean;
    isSendingVideo?: boolean;
    conversationUUID?: string;
    conversationGroupUUID?: string;
    conversationAudioEnabled?: boolean;
    conversationVideoEnabled?: boolean;
    conversationAVMode?: number;
    conversationResolvedAudioVideoMode?: number;
    localMeterLevel?: number;
    remoteMeterLevel?: number;
    maxLocalMeterLevel?: number;
    maxRemoteMeterLevel?: number;
    realtimeActive: boolean;
    audioReady: boolean;
    audioTransport?: ActiveFaceTimeCall["audioTransport"];
    lastHelperAction?: HelperActionResult;
    lastRoutingError?: string;
    carrierHangupPending?: boolean;
    recentTalkEvents?: FaceTimeTalkEventSummary[];
  }>;
};

export function updateCallStatus(call: ActiveFaceTimeCall, event: FaceTimeCallStatusEvent): void {
  call.callStatus = event.data.call_status;
  call.isSendingAudio = event.data.is_sending_audio ?? call.isSendingAudio;
  call.isSendingTransmission = event.data.is_sending_transmission ?? call.isSendingTransmission;
  call.isUplinkMuted = event.data.is_uplink_muted ?? call.isUplinkMuted;
  call.isSendingVideo = event.data.is_sending_video ?? call.isSendingVideo;
  call.conversationUUID = event.data.conversation_uuid ?? call.conversationUUID;
  call.conversationGroupUUID = event.data.conversation_group_uuid ?? call.conversationGroupUUID;
  call.conversationAudioEnabled =
    event.data.conversation_audio_enabled ?? call.conversationAudioEnabled;
  call.conversationVideoEnabled =
    event.data.conversation_video_enabled ?? call.conversationVideoEnabled;
  call.conversationAVMode = event.data.conversation_av_mode ?? call.conversationAVMode;
  call.conversationResolvedAudioVideoMode =
    event.data.conversation_resolved_audio_video_mode ?? call.conversationResolvedAudioVideoMode;
  call.localMeterLevel = event.data.local_meter_level ?? call.localMeterLevel;
  call.remoteMeterLevel = event.data.remote_meter_level ?? call.remoteMeterLevel;
  if (event.data.local_meter_level !== undefined) {
    call.maxLocalMeterLevel = Math.max(call.maxLocalMeterLevel ?? 0, event.data.local_meter_level);
  }
  if (event.data.remote_meter_level !== undefined) {
    call.maxRemoteMeterLevel = Math.max(
      call.maxRemoteMeterLevel ?? 0,
      event.data.remote_meter_level,
    );
  }
}
