import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";

type AcpControllerStopParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason?: string;
  assertActive?: () => void;
};

/** Capture the real Stop receipt so tests can distinguish acceptance from producer settlement. */
export function startAcpControllerStop(params: AcpControllerStopParams) {
  const { storePath, storeSessionKey, agentId } = resolveSessionStorePathForAcp(params);
  const capture = captureSessionControllerStop({
    targets: [
      captureSessionTarget({ storeScope: storePath, sessionKey: storeSessionKey, agentId }),
    ],
  });
  return stopSession({
    source: "client-session",
    capture,
    reason: params.reason,
    assertCurrent: params.assertActive,
    hookContext: { sessionKey: storeSessionKey },
  });
}

/** Exercise the production Stop owner rather than the idle-backend adapter. */
export async function stopAcpControllerTurns(params: AcpControllerStopParams): Promise<void> {
  const stop = startAcpControllerStop(params);
  const results = await Promise.allSettled([stop.completed, stop.settled]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
}
