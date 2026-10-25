import type { InputProvenance } from "../../sessions/input-provenance.js";

export type RequesterAdmissionTarget = {
  runId: string;
  sessionKey: string | undefined;
  sessionId: string | undefined;
  inputProvenance: InputProvenance | undefined;
};

/** Match an admitted continuation to its exact requester authority source. */
export function matchesRequesterCronAuthorityAdmission(
  dispatch: {
    runId: string;
    authority: {
      requesterSessionKey: string;
      requesterSessionId: string;
    } & (
      | { kind: "yield"; batch: readonly { childSessionKey: string }[] }
      | { kind: "followup"; sourceSessionKey: string }
    );
  },
  params: RequesterAdmissionTarget,
): boolean {
  const { authority } = dispatch;
  return (
    dispatch.runId === params.runId &&
    authority.requesterSessionKey === params.sessionKey &&
    authority.requesterSessionId === params.sessionId &&
    params.inputProvenance?.kind === "inter_session" &&
    (authority.kind === "yield"
      ? params.inputProvenance.sourceTool === "subagent_settle" &&
        authority.batch.some(
          (entry) => entry.childSessionKey === params.inputProvenance?.sourceSessionKey,
        )
      : params.inputProvenance.sourceTool === "subagent_announce" &&
        params.inputProvenance.sourceSessionKey === authority.sourceSessionKey)
  );
}
