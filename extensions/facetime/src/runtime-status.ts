import type { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { ActiveFaceTimeCall, FaceTimeRuntimeStatus } from "./runtime-state.js";
import { summarizeRecentTalkEvents } from "./talk-events-summary.js";

export function buildFaceTimeRuntimeStatus(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  driverInstall: FaceTimeRuntimeStatus["driverInstall"];
}): FaceTimeRuntimeStatus {
  const calls = [...params.calls.values()];
  return {
    enabled: true,
    controlMode: "operator-assisted",
    admissionModel: "authenticated-operator-confirms-configured-owner",
    carrierHangupSupported: false,
    driverInstallPending: params.driverInstall.phase === "installing",
    driverInstall: params.driverInstall,
    processOutputSuppressed: calls.some((call) => call.talk?.processOutputSuppressed() === true),
    calls: calls.map((call) => ({
      callUUID: call.callUUID,
      generation: call.generation,
      phase: call.phase,
      carrierMode: call.carrierMode,
      modelMediaMode: call.modelMediaMode,
      handle: call.handle,
      mode: call.mode,
      admission: call.admission,
      realtimeActive: call.talk?.realtimeActive() === true,
      video: call.talk?.videoStatus(),
      audioReady: call.audioReady,
      audioTransport: call.audioTransport
        ? {
            ...call.audioTransport,
            processOutputSuppressed: call.talk?.processOutputSuppressed() === true,
          }
        : undefined,
      lastRoutingError: call.lastRoutingError,
      recentTalkEvents: call.talk
        ? summarizeRecentTalkEvents(call.talk.recentTalkEvents)
        : undefined,
    })),
  };
}
