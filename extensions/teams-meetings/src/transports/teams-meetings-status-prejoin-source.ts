import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type MeetingStatusPreludeParams = Parameters<
  typeof MeetingPlatformAdapter.createStatusPreludeSource
>[0];

export function teamsMeetingStatusPreludeSource(params: MeetingStatusPreludeParams): string {
  return MeetingPlatformAdapter.createStatusPreludeSource(params, {
    controlLookupSource: `const buttons = [...document.querySelectorAll("button")];
  const findTextButton = (pattern) => buttons.find((button) => !button.disabled && pattern.test(label(button)));`,
    lifecycleSource: (sources) => `  const continueInBrowser = first(selectors.continueInBrowser) ||
    findTextButton(/continue on this browser|join on the web|use the web app|continue without the app/i);
  if (canMutateSession && identityVerifiedBeforeCall && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued to the Teams web client.");
    await waitForUi();
  }
${sources.guestName(false)}
  const leave = first(selectors.leave);
  const continueWithoutDevices = findTextButton(/^continue without audio or video$/i);
  let dismissedDevicePrompt = false;
  if (
    canMutateSession &&
    identityVerifiedBeforeCall &&
    !leave &&
    autoJoin &&
    !allowMicrophone &&
    continueWithoutDevices
  ) {
    continueWithoutDevices.click();
    dismissedDevicePrompt = true;
    notes.push("Dismissed the Teams device prompt; selected audio is verified separately.");
    await waitForUi();
  }
  // Teams replaces the meeting URL after admission. Preserve identity only
  // while adopting the first in-call control or retaining that exact control.
  const markerAgeMs = Date.now() - (priorMeeting?.verifiedAt || 0);
  const identityAdoptedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    !priorMeeting?.inCallControl &&
    markerAgeMs >= 0 &&
    markerAgeMs < identityRetentionMs &&
    leave &&
    leave.isConnected !== false
  );
  const identityRerenderedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    priorMeeting?.inCallControl &&
    priorMeeting.inCallControl !== leave &&
    priorMeeting.inCallControl.isConnected === false &&
    priorMeeting?.inCallUrl === location.href &&
    markerAgeMs >= 0 &&
    markerAgeMs < 5_000 &&
    leave &&
    leave.isConnected !== false
  );
  const identityAwaitingRerender = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    priorMeeting?.inCallControl &&
    priorMeeting.inCallControl.isConnected === false &&
    priorMeeting?.inCallUrl === location.href &&
    markerAgeMs >= 0 &&
    markerAgeMs < 5_000 &&
    !leave
  );
${sources.preservedIdentity}
  const inCall = Boolean(identityVerified && leave);
  if (canMutateSession && identityVerified && meetingOwnerConflict) {
    // The tab can survive a Teams SPA meeting/session change. Old hidden bridges
    // must stop, while their muted source streams remain eligible for the new owner.
    adoptAudioBridgeSourcesForSession();
  }
  if (canMutateSession && !inCall && !identityAwaitingRerender) retireOwnedAudioBridges();
  if (canMutateSession && (identityVerifiedBeforeCall || identityPreservedInCall)) {
    window.__openclawTeamsMeeting = {
      ...(priorMeeting?.identity === expectedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      ...(inCall ? { inCallControl: leave, inCallUrl: location.href } : {}),
    };
  } else if (
    canMutateSession &&
    !currentIdentity &&
    priorMeeting &&
    !identityAwaitingRerender &&
    (priorMeeting.inCallControl || markerAgeMs >= identityRetentionMs)
  ) {
    delete window.__openclawTeamsMeeting;
  }
  const microphone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
  let microphoneState = identityVerified ? toggleState(microphone, "microphone") : undefined;
  const refreshMicrophoneState = async () => {
    await waitForUi();
    const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
    microphoneState = toggleState(currentMicrophone, "microphone");
  };
  const camera = first(selectors.camera) || findTextButton(/camera|video/i);
  let cameraState = identityVerified ? toggleState(camera, "camera") : undefined;
  let controlManualAction;
  if (canMutateSession && identityVerified && !inCall && camera && cameraState === "on") {
    camera.click();
    await waitForUi();
    const currentCamera = first(selectors.camera) || findTextButton(/camera|video/i);
    cameraState = toggleState(currentCamera, "camera");
    if (cameraState === "off") {
      notes.push("Turned the Teams camera off before joining.");
    }
  }
  const join = first(selectors.join) || findTextButton(/^\\s*(join now|ask to join|join meeting)\\s*$/i);
  if (identityVerified && !inCall && join && cameraState !== "off") {
    controlManualAction = manualActionFor("teams-camera-required", "Turn the Teams camera off and verify the camera control shows it is off, then retry joining.");
  }
${sources.virtualAudioInput({
  selectionSource: `      const preparedInput = window.__openclawTeamsMeeting;
      const preparedSelection = Boolean(
        readOnly &&
        preparedInput?.identity === expectedIdentity &&
        (!sessionId || preparedInput?.sessionId === sessionId) &&
        preparedInput?.audioInputDeviceId === input.deviceId
      );
      let selected = Boolean(selectedMicrophoneLabel()) || preparedSelection;`,
  afterSelectionSource: `      if (selected && window.__openclawTeamsMeeting?.identity === expectedIdentity) {
        window.__openclawTeamsMeeting.audioInputDeviceId = input.deviceId;
      }
`,
})}
${sources.prejoinMicrophone({
  unroutedSource: `      controlManualAction = manualActionFor("teams-audio-choice-required", "Select the OpenClaw virtual audio device as the Teams microphone and verify it is selected before enabling talk-back.");`,
  afterRoutedSource: `    if (audioInputRouted && microphoneState !== "on") {
      controlManualAction = manualActionFor("teams-microphone-required", "Unmute the Teams microphone and verify the microphone control shows it is on, then retry joining.");
    }
`,
  muteInCall: false,
})}
${sources.inCallMicrophone}
  if (identityVerified && !inCall && join && !allowMicrophone && microphoneState !== "off") {
    controlManualAction = manualActionFor("teams-microphone-required", "Mute the Teams microphone and verify the microphone control shows it is off, then retry joining.");
  }
  if (identityVerified && !inCall && join && allowMicrophone && !controlManualAction) {
    if (!microphone) {
      controlManualAction = manualActionFor("teams-microphone-required", "Open Teams device settings and verify the microphone control before enabling talk-back.");
    } else if (audioInputRouted !== true) {
      controlManualAction = manualActionFor("teams-audio-choice-required", "Select the OpenClaw virtual audio device as the Teams microphone and verify it is selected before enabling talk-back.");
    } else if (microphoneState !== "on") {
      controlManualAction = manualActionFor("teams-microphone-required", "Unmute the Teams microphone and verify the microphone control shows it is on, then retry joining.");
    }
  }`,
    manualActionSource: (sources) => `  const pageText = text(document.body);
  const pageTextLower = pageText.toLowerCase();
  const lobbyWaiting = Boolean(first(selectors.lobby)) ||
    /someone will let you in shortly|waiting for someone to let you in|when someone admits you|you.?re in the lobby|we.?ve let people in the meeting know you.?re waiting/i.test(pageTextLower);
  const signInControl = first(selectors.signIn);
  const hostname = location.hostname.toLowerCase();
  const tenantLoginRequired =
    /only people with a work or school account|sign in with an account from this organization|anonymous users (?:can.?t|cannot) join|verify your email|enter the code sent to/i.test(pageTextLower);
  const loginRequired = hostname === "login.microsoftonline.com" ||
    hostname.endsWith(".microsoftonline.com") ||
    tenantLoginRequired ||
    (Boolean(signInControl) && !guestInput && !join && /sign in to (?:join|continue)|sign in to your account/i.test(pageTextLower));
${sources.manualActions({ loginDisplayName: "Microsoft Teams", inCallControls: false })}`,
    platform: {
      displayName: "Teams",
      globals: {
        audioOutputs: "__openclawTeamsAudioOutputs",
        captionArchive: "__openclawTeamsCaptionArchive",
        captions: "__openclawTeamsCaptions",
        meeting: "__openclawTeamsMeeting",
      },
      manualActionReasonPrefix: "teams",
    },
  });
}
