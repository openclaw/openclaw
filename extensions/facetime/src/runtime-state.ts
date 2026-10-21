import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { FaceTimeCallStatusEvent, AuthenticatedFaceTimeOwner } from "./call-events.js";
import type { HelperActionResult } from "./helper-results.js";
import type { FaceTimeHelperPeer } from "./helper-rpc.js";
import type { FaceTimeHelperSupervisorStatus } from "./helper-supervisor.js";
import type { FaceTimeDialMode, PendingFaceTimeDial } from "./outbound-call.js";
import type { FaceTimeTalkDriver } from "./talk-driver.js";
import type { FaceTimeTalkEventSummary } from "./talk-events-summary.js";

type FaceTimeCarrierMode = "ringing" | "muted" | "active" | "closing" | "closed";

type FaceTimeModelMediaMode = "starting" | "ready" | "active" | "suspended" | "closed";

type FaceTimeCallPhase = "ringing" | "answering" | "active" | "closing" | "closed";

function normalizeCallIdentity(value: string): string {
  return value.trim().toLowerCase();
}

export class ActiveFaceTimeCall {
  readonly lifecycleAbort = new AbortController();
  readonly aliases = new Set<string>();
  generation = 1;
  phase: FaceTimeCallPhase;
  carrierMode: FaceTimeCarrierMode;
  modelMediaMode: FaceTimeModelMediaMode = "starting";
  #carrierClosure = createDeferred<void>();
  readonly carrierClosure = this.#carrierClosure.promise;
  #commandTail: Promise<void> = Promise.resolve();

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
    this.phase = params.phase;
    this.carrierMode = params.phase === "ringing" ? "ringing" : "muted";
    this.aliases.add(normalizeCallIdentity(params.callUUID));
    this.callUUID = params.callUUID;
    this.carrierCallUUID = params.callUUID;
    this.carrierCallUUIDs = new Set([params.callUUID]);
    this.senderId = params.owner.senderId;
    this.handle = params.handle;
    if (params.peer) {
      this.carrierPeers.set(params.peer.processId, params.peer);
    }
  }

  captureGeneration(): number {
    return this.generation;
  }

  assertCurrent(generation: number, allowClosing = false): void {
    const phaseAllowed = allowClosing
      ? this.phase !== "closed" && this.carrierMode !== "closed"
      : this.phase !== "closing" && this.phase !== "closed";
    if (
      generation !== this.generation ||
      !phaseAllowed ||
      (!allowClosing && this.lifecycleAbort.signal.aborted)
    ) {
      throw new Error("FaceTime call lifecycle changed during carrier command");
    }
  }

  async runCarrierCommand<T>(params: {
    generation: number;
    allowClosing?: boolean;
    action: () => Promise<T>;
  }): Promise<T> {
    const previous = this.#commandTail;
    const { promise, resolve: release } = createDeferred<void>();
    this.#commandTail = promise;
    await previous;
    try {
      this.assertCurrent(params.generation, params.allowClosing);
      const result = await params.action();
      this.assertCurrent(params.generation, params.allowClosing);
      return result;
    } finally {
      release();
    }
  }

  beginAnswering(): number {
    if (this.phase !== "ringing") {
      throw new Error(`cannot answer FaceTime call in ${this.phase} phase`);
    }
    this.phase = "answering";
    this.carrierMode = "muted";
    return this.generation;
  }

  markCarrierActive(generation: number): void {
    this.assertCurrent(generation);
    this.phase = "active";
    this.carrierMode = "active";
  }

  markModelReady(generation: number): void {
    this.assertCurrent(generation);
    this.modelMediaMode = "ready";
  }

  markModelActive(generation: number): void {
    this.assertCurrent(generation);
    this.modelMediaMode = "active";
  }

  suspendModelMedia(): void {
    if (this.modelMediaMode !== "closed") {
      this.modelMediaMode = "suspended";
    }
  }

  beginClosing(): number {
    if (this.phase === "closed") {
      return this.generation;
    }
    if (this.phase !== "closing") {
      this.generation += 1;
      this.phase = "closing";
      this.carrierMode = "closing";
      this.suspendModelMedia();
      this.lifecycleAbort.abort(new Error("FaceTime call is closing"));
    }
    return this.generation;
  }

  // Carrier proof releases startup before local media teardown can be joined.
  markCarrierClosed(): void {
    this.beginClosing();
    this.carrierMode = "closed";
    this.#carrierClosure.resolve(undefined);
  }

  markClosed(): void {
    this.phase = "closed";
    this.carrierMode = "closed";
    this.modelMediaMode = "closed";
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

export class FaceTimeCallRegistry {
  #active: ActiveFaceTimeCall | undefined;

  get active(): ActiveFaceTimeCall | undefined {
    return this.#active;
  }

  get size(): number {
    return this.#active && this.#active.phase !== "closed" ? 1 : 0;
  }

  values(): IterableIterator<ActiveFaceTimeCall> {
    return (this.#active && this.#active.phase !== "closed" ? [this.#active] : [])[
      Symbol.iterator
    ]();
  }

  get(identity: string): ActiveFaceTimeCall | undefined {
    return this.#active?.aliases.has(normalizeCallIdentity(identity)) ? this.#active : undefined;
  }

  has(identity: string): boolean {
    return this.get(identity) !== undefined;
  }

  create(call: ActiveFaceTimeCall): void {
    if (this.#active && this.#active.phase !== "closed") {
      throw new Error("another FaceTime call lifecycle is already active");
    }
    this.#active = call;
  }

  retainAlias(call: ActiveFaceTimeCall, identity: string): void {
    if (this.#active !== call || call.phase === "closed") {
      throw new Error("cannot retain an alias for an inactive FaceTime call");
    }
    call.aliases.add(normalizeCallIdentity(identity));
  }

  close(call: ActiveFaceTimeCall): void {
    if (this.#active !== call) {
      return;
    }
    call.markClosed();
    this.#active = undefined;
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
    audioTransport?: ActiveFaceTimeCall["audioTransport"] & {
      processOutputSuppressed: boolean;
    };
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
