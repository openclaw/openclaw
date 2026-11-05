export const DIAL_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);

export type FaceTimeHelperPeer = {
  bundleIdentifier: string;
  processId: number;
  processStartedAtMs: number;
  connectionGeneration: number;
};

export type HelperActionResult = Record<string, unknown> & {
  helperBundleIdentifier?: string;
  helperPeer?: FaceTimeHelperPeer;
  helperResults?: HelperActionResult[];
  helpersContacted?: number;
  topologyGeneration?: number;
  topologyComplete?: boolean;
};

export class FaceTimeHelperAmbiguousError extends Error {
  constructor(
    message: string,
    readonly result: HelperActionResult = {},
  ) {
    super(message);
    this.name = "FaceTimeHelperAmbiguousError";
  }
}

export class FaceTimeHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperUnavailableError";
  }
}

export function readHelperResults(result: HelperActionResult): HelperActionResult[] {
  return result.helperResults ?? [result];
}

function requireCompleteTopology(result: HelperActionResult): HelperActionResult[] {
  const results = readHelperResults(result);
  if (result.topologyComplete !== true || results.length !== result.helpersContacted) {
    throw new FaceTimeHelperAmbiguousError("FaceTime helper topology was incomplete", result);
  }
  return results;
}

export function assertFaceTimeNativeAction(
  action: "answer" | "safe-mute" | "unmute" | "activate" | "terminate",
  result: HelperActionResult,
): void {
  const results = requireCompleteTopology(result);
  const present = results.filter((entry) => entry.outcome !== "absent");
  // FaceTime and its conversation service can both proxy the same system TUCall.
  // Every helper that found the exact call must prove the postcondition.
  if (present.length === 0) {
    throw new FaceTimeHelperAmbiguousError(`FaceTime ${action} carrier owner is missing`, result);
  }
  if (
    (action === "unmute" || action === "activate") &&
    present.every(
      (observed) =>
        observed.muted === false &&
        observed.is_uplink_muted === false &&
        typeof observed.conversation_audio_error !== "string" &&
        (action === "unmute" ||
          (observed.is_sending_audio === true && observed.is_sending_transmission === true)),
    )
  ) {
    return;
  }
  if (
    (action === "answer" || action === "safe-mute") &&
    present.every(
      (observed) =>
        observed.muted === true &&
        observed.is_uplink_muted === true &&
        (action === "answer"
          ? observed.outcome === "answered-muted"
          : observed.downlink_muted === true),
    )
  ) {
    return;
  }
  if (
    action === "terminate" &&
    present.every((observed) => observed.outcome === "termination-requested")
  ) {
    return;
  }
  throw new Error(`FaceTime ${action} postcondition was not observed`);
}

export function projectCompleteFaceTimeAbsence(result: HelperActionResult): number {
  const results = requireCompleteTopology(result);
  if (!results.every((entry) => entry.outcome === "absent" && entry.found === false)) {
    throw new FaceTimeHelperAmbiguousError("FaceTime carrier is still present", result);
  }
  if (result.topologyGeneration === undefined) {
    throw new FaceTimeHelperAmbiguousError("FaceTime topology generation is missing", result);
  }
  return result.topologyGeneration;
}
