export type HelperActionResult = Record<string, unknown>;

type FaceTimeNativeActionOutcome =
  | { status: "answered-muted" }
  | { status: "safe-muted" }
  | { status: "media-active" }
  | { status: "termination-requested" }
  | { status: "absent" };

export class FaceTimeHelperActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperActionError";
  }
}

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
  return Array.isArray(result.helperResults)
    ? result.helperResults.filter((entry): entry is HelperActionResult =>
        Boolean(entry && typeof entry === "object"),
      )
    : [result];
}

function requireCompleteTopology(result: HelperActionResult): HelperActionResult[] {
  const results = readHelperResults(result);
  if (
    result.topologyComplete !== true ||
    typeof result.helpersContacted !== "number" ||
    results.length !== result.helpersContacted
  ) {
    throw new FaceTimeHelperAmbiguousError("FaceTime helper topology was incomplete", result);
  }
  return results;
}

export function projectFaceTimeNativeAction(
  action: "answer" | "safe-mute" | "unmute" | "activate" | "terminate",
  result: HelperActionResult,
): FaceTimeNativeActionOutcome {
  const results = requireCompleteTopology(result);
  const present = results.filter((entry) => entry.outcome !== "absent");
  // FaceTime and Phone can both proxy the same system TUCall. Accept shared
  // visibility only when every helper that found the exact call proves the postcondition.
  if (present.length === 0) {
    throw new FaceTimeHelperAmbiguousError(`FaceTime ${action} carrier owner is missing`, result);
  }
  if (
    action === "unmute" &&
    present.every(
      (observed) =>
        observed.muted === false &&
        observed.is_uplink_muted === false &&
        typeof observed.conversation_audio_error !== "string",
    )
  ) {
    return { status: "media-active" };
  }
  if (
    action === "answer" &&
    present.every(
      (observed) =>
        observed.outcome === "answered-muted" &&
        observed.muted === true &&
        observed.is_uplink_muted === true,
    )
  ) {
    return { status: "answered-muted" };
  }
  if (
    action === "safe-mute" &&
    present.every(
      (observed) =>
        observed.downlink_muted === true &&
        observed.muted === true &&
        observed.is_uplink_muted === true,
    )
  ) {
    return { status: "safe-muted" };
  }
  if (
    action === "activate" &&
    present.every(
      (observed) =>
        observed.muted === false &&
        observed.is_uplink_muted === false &&
        observed.is_sending_audio === true &&
        observed.is_sending_transmission === true &&
        typeof observed.conversation_audio_error !== "string",
    )
  ) {
    return { status: "media-active" };
  }
  if (
    action === "terminate" &&
    present.every((observed) => observed.outcome === "termination-requested")
  ) {
    return { status: "termination-requested" };
  }
  throw new FaceTimeHelperActionError(`FaceTime ${action} postcondition was not observed`);
}

export function projectCompleteFaceTimeAbsence(result: HelperActionResult): {
  status: "absent";
  topologyGeneration: number;
} {
  const results = requireCompleteTopology(result);
  if (!results.every((entry) => entry.outcome === "absent" && entry.found === false)) {
    throw new FaceTimeHelperAmbiguousError("FaceTime carrier is still present", result);
  }
  if (typeof result.topologyGeneration !== "number") {
    throw new FaceTimeHelperAmbiguousError("FaceTime topology generation is missing", result);
  }
  return { status: "absent", topologyGeneration: result.topologyGeneration };
}
