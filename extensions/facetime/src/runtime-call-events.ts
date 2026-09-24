import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isOutgoingRingingCall,
  isUnknownCallStatus,
  isVerifiedFaceTimeTransport,
  normalizeFaceTimeHandle,
  resolveAuthorizedFaceTimeOwner,
  type AuthenticatedFaceTimeOwner,
  type FaceTimeCallStatusEvent,
} from "./call-events.js";
import type { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { FaceTimeConfig } from "./config.js";
import {
  projectFaceTimeNativeAction,
  type FaceTimeHelperPeer,
  type FaceTimeHelperSocketServer,
} from "./helper-rpc.js";
import {
  doesFaceTimeCallMatchPendingDial,
  retainFaceTimeDialCallUUID,
  type PendingFaceTimeDial,
} from "./outbound-call.js";
import { retainHelperResultPeers } from "./runtime-helper-results.js";
import {
  createManagedCall,
  readCallUUID,
  updateCallStatus,
  type ActiveFaceTimeCall,
} from "./runtime-state.js";

type CallControl = {
  activateCallTalk(call: ActiveFaceTimeCall, options: { unmute: boolean }): Promise<void>;
  attemptCarrierHangup(call: ActiveFaceTimeCall, reason: string): Promise<boolean>;
  closeCall(call: ActiveFaceTimeCall, reason: string): Promise<void>;
  startCallTalk(call: ActiveFaceTimeCall): Promise<void>;
};

export function createFaceTimeCallEventHandler(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  helper: FaceTimeHelperSocketServer;
  config: FaceTimeConfig;
  logger: RuntimeLogger;
  callControl: CallControl;
  isStopping: () => boolean;
  isDriverInstallPending: () => boolean;
  getPendingDial: () => PendingFaceTimeDial | undefined;
  clearPendingDial: () => Promise<void>;
  persistPendingDial: () => Promise<void>;
  outboundCarrierPeers: ReadonlyMap<number, FaceTimeHelperPeer>;
  cancelPendingDial: (pending: PendingFaceTimeDial) => Promise<void>;
}) {
  const eventIdentities = (event: FaceTimeCallStatusEvent): string[] =>
    [
      event.data.call_uuid,
      event.data.dial_id,
      event.data.proxy_identifier,
      event.data.conversation_uuid,
    ].filter(
      (identity): identity is string => typeof identity === "string" && identity.trim() !== "",
    );
  const resolveEventCall = (event: FaceTimeCallStatusEvent) => {
    for (const identity of eventIdentities(event)) {
      const call = params.calls.get(identity);
      if (call) {
        return call;
      }
    }
    return undefined;
  };
  const canPromotePendingDial = (pending: PendingFaceTimeDial) =>
    !params.isStopping() &&
    params.getPendingDial() === pending &&
    pending.delivery !== "cancelling";
  const authorizePendingDial = async (
    event: FaceTimeCallStatusEvent,
    pending: PendingFaceTimeDial,
  ): Promise<AuthenticatedFaceTimeOwner | undefined> => {
    retainFaceTimeDialCallUUID(pending, readCallUUID(event));
    await params.persistPendingDial();
    if (params.isStopping() || params.getPendingDial() !== pending) {
      return undefined;
    }
    const owner =
      pending.delivery === "cancelling"
        ? undefined
        : resolveAuthorizedFaceTimeOwner({
            event,
            ownerHandles: params.config.ownerHandles,
          });
    if (owner) {
      return owner;
    }
    if (pending.delivery !== "cancelling") {
      params.logger.warn(
        "[facetime] cancelling correlated outbound call because its handle is no longer authorized; add it to ownerHandles before dialing again",
      );
    }
    try {
      await params.cancelPendingDial(pending);
    } catch (error) {
      params.logger.warn(
        `[facetime] outbound authorization cancellation remains pending: ${formatErrorMessage(error)}`,
      );
    }
    return undefined;
  };
  const retainAliases = (call: ActiveFaceTimeCall, event: FaceTimeCallStatusEvent) => {
    for (const alias of [
      event.data.call_uuid,
      event.data.dial_id,
      event.data.proxy_identifier,
      event.data.conversation_uuid,
      event.data.conversation_group_uuid,
    ]) {
      if (typeof alias === "string" && alias.trim()) {
        params.calls.retainAlias(call, alias);
      }
    }
    call.carrierCallUUIDs.add(String(event.data.call_uuid));
  };
  const retainPendingDial = (call: ActiveFaceTimeCall, pending: PendingFaceTimeDial) => {
    params.calls.retainAlias(call, pending.dialID);
    if (pending.proxyIdentifier) {
      params.calls.retainAlias(call, pending.proxyIdentifier);
    }
    for (const alias of pending.callUUIDAliases ?? []) {
      params.calls.retainAlias(call, alias);
      call.carrierCallUUIDs.add(alias);
    }
    for (const carrierPeer of params.outboundCarrierPeers.values()) {
      call.carrierPeers.set(carrierPeer.processId, carrierPeer);
    }
  };
  const answerIncoming = async (
    event: FaceTimeCallStatusEvent,
    owner: AuthenticatedFaceTimeOwner,
    peer?: FaceTimeHelperPeer,
  ) => {
    const callUUID = readCallUUID(event);
    if (params.isDriverInstallPending()) {
      params.logger.warn("[facetime] ignored incoming call; audio driver installation is pending");
      return;
    }
    if (resolveEventCall(event)) {
      return;
    }
    if (params.calls.size > 0) {
      params.logger.warn("[facetime] ignored incoming call; another FaceTime bridge is active");
      return;
    }
    const call = createManagedCall({
      callUUID,
      phase: "ringing",
      owner,
      handle: normalizeFaceTimeHandle(event.data.handle),
      peer,
    });
    updateCallStatus(call, event);
    params.calls.create(call);
    retainAliases(call, event);
    let answerAttempted = false;
    try {
      await params.callControl.startCallTalk(call);
      if (
        call.lifecycleAbort.signal.aborted ||
        params.calls.active !== call ||
        call.carrierHangupPending
      ) {
        throw new Error("FaceTime call closed before answer");
      }
      const generation = call.beginAnswering();
      answerAttempted = true;
      const answerResult = await call.runCarrierCommand({
        generation,
        action: async () => await params.helper.answerCall(callUUID),
      });
      projectFaceTimeNativeAction("answer", answerResult);
      retainHelperResultPeers(call, answerResult);
      await params.callControl.activateCallTalk(call, { unmute: true });
      params.logger.info("[facetime] answered authorized FaceTime call");
    } catch (error) {
      params.logger.warn(`[facetime] failed to answer FaceTime call: ${formatErrorMessage(error)}`);
      if (answerAttempted) {
        await params.callControl.attemptCarrierHangup(call, "answer-failed");
        return;
      }
      await params.callControl.closeCall(call, "answer-failed").catch((closeError: unknown) => {
        params.logger.warn(
          `[facetime] answer failure cleanup failed: ${formatErrorMessage(closeError)}`,
        );
      });
    }
  };
  const activate = async (
    event: FaceTimeCallStatusEvent,
    owner?: AuthenticatedFaceTimeOwner,
    peer?: FaceTimeHelperPeer,
    pending?: PendingFaceTimeDial,
  ) => {
    const callUUID = readCallUUID(event);
    if (params.isDriverInstallPending()) {
      params.logger.warn("[facetime] ignored active call; audio driver installation is pending");
      return;
    }
    let call = resolveEventCall(event);
    if (!call) {
      if (!owner) {
        params.logger.warn("[facetime] refused active call without authenticated owner");
        return;
      }
      if (params.calls.size > 0) {
        params.logger.warn("[facetime] ignored active call; another FaceTime bridge is active");
        return;
      }
      call = createManagedCall({
        callUUID,
        phase: "active",
        owner,
        handle: normalizeFaceTimeHandle(event.data.handle),
        peer,
      });
      params.calls.create(call);
      retainAliases(call, event);
    }
    if (pending) {
      retainPendingDial(call, pending);
    }
    if (peer) {
      call.carrierPeers.set(peer.processId, peer);
    }
    // Apple can replace the ringing call object when it becomes active. Keep
    // lifecycle identity stable, but direct subsequent commands to this owner event's UUID.
    call.promoteCarrierCallUUID(callUUID);
    updateCallStatus(call, event);
    try {
      await params.callControl.startCallTalk(call);
      await params.callControl.activateCallTalk(call, { unmute: true });
      params.logger.info("[facetime] realtime talk session active");
    } catch (error) {
      if (call.lifecycleAbort.signal.aborted || params.calls.active !== call) {
        return;
      }
      params.logger.warn(`[facetime] failed to start realtime talk: ${formatErrorMessage(error)}`);
      await params.callControl.attemptCarrierHangup(call, "talk-start-failed");
    }
  };
  const handleCallEvent = async (event: FaceTimeCallStatusEvent, peer?: FaceTimeHelperPeer) => {
    if (params.isStopping()) {
      return;
    }
    const callUUID = readCallUUID(event);
    const existingCall = resolveEventCall(event);
    const pending = params.getPendingDial();
    if (existingCall) {
      if (peer) {
        existingCall.carrierPeers.set(peer.processId, peer);
      }
      updateCallStatus(existingCall, event);
      retainAliases(existingCall, event);
    }
    const verifiedTransport = isVerifiedFaceTimeTransport(event);
    if (existingCall && !verifiedTransport && !isEndedCall(event)) {
      params.logger.warn(
        "[facetime] managed call transport lost FaceTime verification; closing fail-closed",
      );
      await params.callControl.attemptCarrierHangup(existingCall, "transport-verification-lost");
      return;
    }
    if (
      pending &&
      !existingCall &&
      event.data.is_outgoing !== true &&
      (isIncomingRingingCall(event) || isActiveCall(event))
    ) {
      params.logger.info("[facetime] ignored incoming call; an outbound FaceTime call is pending");
      return;
    }
    if (isIncomingRingingCall(event)) {
      const owner = resolveAuthorizedFaceTimeOwner({
        event,
        ownerHandles: params.config.ownerHandles,
      });
      if (owner) {
        await answerIncoming(event, owner, peer);
      } else {
        params.logger.info("[facetime] ignored unauthorized incoming FaceTime call");
      }
      return;
    }
    if (isOutgoingRingingCall(event)) {
      if (verifiedTransport && pending && doesFaceTimeCallMatchPendingDial({ event, pending })) {
        const owner = await authorizePendingDial(event, pending);
        if (!owner || !canPromotePendingDial(pending)) {
          return;
        }
        let ringingCall = resolveEventCall(event);
        if (!ringingCall && params.calls.size === 0) {
          ringingCall = createManagedCall({
            callUUID,
            phase: "ringing",
            owner,
            handle: normalizeFaceTimeHandle(event.data.handle),
            peer,
          });
          updateCallStatus(ringingCall, event);
          params.calls.create(ringingCall);
          retainAliases(ringingCall, event);
          retainPendingDial(ringingCall, pending);
        }
        if (ringingCall) {
          try {
            const generation = ringingCall.captureGeneration();
            const muteResult = await ringingCall.runCarrierCommand({
              generation,
              action: async () => await params.helper.safetyMute(ringingCall.carrierCallUUID),
            });
            ringingCall.lastHelperAction = muteResult;
            retainHelperResultPeers(ringingCall, muteResult);
            projectFaceTimeNativeAction("safe-mute", muteResult);
          } catch (error) {
            params.logger.warn(
              `[facetime] outbound ringing safety mute failed: ${formatErrorMessage(error)}`,
            );
            await params.callControl.attemptCarrierHangup(
              ringingCall,
              "outbound-ringing-safety-mute-failed",
            );
          }
        }
      }
      return;
    }
    if (isActiveCall(event)) {
      const authorizedPending =
        event.data.is_outgoing === true &&
        verifiedTransport &&
        pending &&
        doesFaceTimeCallMatchPendingDial({ event, pending })
          ? pending
          : undefined;
      const owner = authorizedPending
        ? await authorizePendingDial(event, authorizedPending)
        : event.data.is_outgoing === true
          ? undefined
          : resolveAuthorizedFaceTimeOwner({
              event,
              ownerHandles: params.config.ownerHandles,
            });
      if (authorizedPending && (!owner || !canPromotePendingDial(authorizedPending))) {
        return;
      }
      const pendingCall = authorizedPending && params.calls.get(authorizedPending.dialID);
      if (pendingCall) {
        params.calls.retainAlias(pendingCall, callUUID);
      }
      if (!resolveEventCall(event) && !owner) {
        params.logger.info("[facetime] ignored unauthorized active FaceTime call");
        return;
      }
      await activate(event, owner, peer, authorizedPending);
      if (
        authorizedPending &&
        canPromotePendingDial(authorizedPending) &&
        params.calls.has(callUUID)
      ) {
        await params.clearPendingDial();
      }
      return;
    }
    if (isEndedCall(event)) {
      const clearing =
        event.data.is_outgoing === true &&
        pending &&
        doesFaceTimeCallMatchPendingDial({ event, pending })
          ? params.clearPendingDial()
          : undefined;
      const endedCall = resolveEventCall(event);
      if (endedCall) {
        if (endedCall.retiredCarrierCallUUIDs.has(callUUID)) {
          params.logger.debug?.(
            "[facetime] ignored ended event for a stale carrier alias while another carrier is current",
          );
          await clearing;
          return;
        }
        // Native terminal evidence revokes media immediately, even while SQLite settles.
        endedCall.markCarrierClosed();
        await Promise.all([clearing, params.callControl.closeCall(endedCall, "native-ended")]);
      } else {
        await clearing;
      }
      return;
    }
    if (isUnknownCallStatus(event)) {
      const unknownCall = params.calls.get(callUUID);
      if (unknownCall) {
        params.logger.warn("[facetime] unknown native call status; closing carrier fail-closed");
        await params.callControl.attemptCarrierHangup(unknownCall, "unknown-native-status");
      }
    }
  };
  return { handleCallEvent };
}
