import { FaceTimeCallInstance } from "./call-lifecycle.js";
import type { FaceTimeDialMode } from "./outbound-call.js";
import type { FaceTimeTalkDriver } from "./talk-driver.js";
import type { FaceTimeTalkEventSummary } from "./talk-events-summary.js";

export class ActiveFaceTimeCall extends FaceTimeCallInstance {
  readonly callUUID: string;
  readonly senderId: string;
  readonly senderIsOwner = true as const;
  readonly admission = "operator-confirmed-owner" as const;
  readonly handle: string;
  readonly mode: FaceTimeDialMode;
  audioReady = false;
  audioTransport?: {
    captureBinary: string;
    feedDevice: string;
    microphoneDevice: string;
    processInputVerified: boolean;
    processOutputSuppressed: boolean;
  };
  lastRoutingError?: string;
  audioRouting?: Promise<void>;
  talk?: FaceTimeTalkDriver;
  talkStarting?: Promise<void>;
  talkActivation?: Promise<void>;

  constructor(params: { callUUID: string; handle: string; mode: FaceTimeDialMode }) {
    super(params.callUUID, "active");
    this.callUUID = params.callUUID;
    this.senderId = params.handle;
    this.handle = params.handle;
    this.mode = params.mode;
  }
}

export type FaceTimeRuntimeStatus = {
  enabled: true;
  controlMode: "operator-assisted";
  admissionModel: "authenticated-operator-confirms-configured-owner";
  carrierHangupSupported: false;
  driverInstallPending: boolean;
  driverInstall: {
    phase: "idle" | "installing" | "succeeded" | "failed";
    startedAt?: string;
    finishedAt?: string;
    changed?: boolean;
    error?: string;
  };
  processOutputSuppressed: boolean;
  calls: Array<{
    callUUID: string;
    generation: number;
    phase: ActiveFaceTimeCall["phase"];
    carrierMode: ActiveFaceTimeCall["carrierMode"];
    modelMediaMode: ActiveFaceTimeCall["modelMediaMode"];
    handle: string;
    mode: FaceTimeDialMode;
    admission: ActiveFaceTimeCall["admission"];
    realtimeActive: boolean;
    video?: ReturnType<FaceTimeTalkDriver["videoStatus"]>;
    audioReady: boolean;
    audioTransport?: ActiveFaceTimeCall["audioTransport"];
    lastRoutingError?: string;
    recentTalkEvents?: FaceTimeTalkEventSummary[];
  }>;
};
