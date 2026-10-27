import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  captureRequesterOrigin,
  decodeRequesterOrigin,
  resolveRequesterPrincipalKey,
  type RequesterOrigin,
} from "./requester-origin.js";

/** Facts retained by the existing restart claim, never an execution grant. */
export type RestartRecoveryRequesterSource = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceRunId: string;
  requesterOrigin: RequesterOrigin;
}>;

export function createRestartRecoveryRequesterSource(params: {
  requesterOrigin?: RequesterOrigin;
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
}): RestartRecoveryRequesterSource | undefined {
  const requesterOrigin = params.requesterOrigin && captureRequesterOrigin(params);
  if (
    !requesterOrigin ||
    !resolveRequesterPrincipalKey({ requesterOrigin }) ||
    params.entry.incognito
  ) {
    return undefined;
  }
  const source = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    lifecycleRevision: params.entry.lifecycleRevision,
    sourceRunId: params.sourceRunId,
    requesterOrigin,
  };
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= 65_536
    ? Object.freeze(source)
    : undefined;
}

/** Only a private current session claim supplies this source; transcript copies cannot. */
export function readRestartRecoveryRequesterSource(params: {
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
}): RequesterOrigin | undefined {
  const source = params.entry.restartRecoveryRequesterSource;
  if (
    !source ||
    source.agentId !== params.agentId ||
    source.sessionKey !== params.sessionKey ||
    source.sessionId !== params.entry.sessionId ||
    source.lifecycleRevision !== params.entry.lifecycleRevision ||
    source.sourceRunId !== params.sourceRunId
  ) {
    return undefined;
  }
  const requesterOrigin = decodeRequesterOrigin(source.requesterOrigin);
  return requesterOrigin && resolveRequesterPrincipalKey({ requesterOrigin })
    ? requesterOrigin
    : undefined;
}
