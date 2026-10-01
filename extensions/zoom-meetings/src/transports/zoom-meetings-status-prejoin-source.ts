import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

type MeetingStatusPreludeParams = Parameters<
  typeof MeetingPlatformAdapter.createStatusPreludeSource
>[0];

export function zoomMeetingStatusPreludeSource(params: MeetingStatusPreludeParams): string {
  return MeetingPlatformAdapter.createStatusPreludeSource(params, {
    controlLookupSource: `const findTextButton = (pattern) => [...document.querySelectorAll("button")]
    .find((button) => !button.disabled && pattern.test(label(button)));
  const findTextControl = (pattern) =>
    [...document.querySelectorAll('button, a, [role="button"]')]
      .find((control) => !control.disabled && pattern.test(label(control)));`,
    lifecycleSource: (sources) => `  const continueInBrowser = first(selectors.continueInBrowser) ||
    findTextButton(/join from browser|continue on this browser|join on the web|use the web app|continue without the app/i);
  if (canMutateSession && identityVerifiedBeforeCall && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued to the Zoom web client.");
    await waitForUi();
  }
${sources.guestName(true)}
  const leave = first(selectors.leave);
  let continueWithoutDevices = findTextControl(/\\bcontinue without (?:audio or video|microphone(?: and camera)?)\\b/i);
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
    notes.push("Continued past the Zoom device prompt in observe-only mode.");
    await waitForUi();
    continueWithoutDevices = findTextControl(
      /\\bcontinue without (?:audio or video|microphone(?: and camera)?)\\b/i
    );
    if (continueWithoutDevices) {
      continueWithoutDevices.click();
      await waitForUi();
    }
  } else if (
    canMutateSession &&
    identityVerifiedBeforeCall &&
    !leave &&
    autoJoin &&
    allowMicrophone
  ) {
    const useMicrophone = document.querySelector('usermedia.pepc-permission-dialog__permission-button[type*="microphone"]');
    if (useMicrophone) {
      useMicrophone.click();
      notes.push("Requested Zoom microphone access from the prejoin prompt.");
      await waitForUi();
    }
  }
  const pageText = text(document.body);
  const pageTextLower = pageText.toLowerCase();
  const lobbyWaiting = Boolean(first(selectors.lobby)) ||
    /host will let you in soon|waiting for the host to start|someone will let you in shortly|waiting for someone to let you in|when someone admits you|you.?re in the lobby|we.?ve let people in the meeting know you.?re waiting/i.test(pageTextLower);

  const devicesDisabled = Boolean(!allowMicrophone && (dismissedDevicePrompt || (priorMeeting?.identity === expectedIdentity && (!sessionId || priorMeeting?.sessionId === sessionId) && priorMeeting?.devicesDisabled === true)));
  // Zoom replaces the meeting URL after admission; retain only an adopted in-call control.
  // Lobby ownership remains durable because host admission has no bounded wait.
  const markerAgeMs = Date.now() - (priorMeeting?.verifiedAt || 0);
  const inCallControlDisconnected = Boolean(!currentIdentity && priorMeeting?.identity === expectedIdentity && priorMeeting?.inCallControl?.isConnected === false);
  if (inCallControlDisconnected && !leave) priorMeeting.inCallControlLostAt ||= Date.now();
  const inCallControlLossAgeMs = Date.now() - (priorMeeting?.inCallControlLostAt || Date.now());
  const identityAdoptedInCall = Boolean(
    !currentIdentity &&
    priorMeeting?.identity === expectedIdentity &&
    !priorMeeting?.inCallControl &&
    (
      priorMeeting?.awaitingAdmission === true ||
      (markerAgeMs >= 0 && markerAgeMs < identityRetentionMs)
    ) &&
    leave &&
    leave.isConnected !== false
  );
  const identityRerenderedInCall = Boolean(
    inCallControlDisconnected &&
    priorMeeting.inCallControl !== leave &&
    priorMeeting?.inCallUrl === location.href &&
    leave &&
    leave.isConnected !== false
  );
  const identityAwaitingRerender = Boolean(
    inCallControlDisconnected &&
    inCallControlLossAgeMs >= 0 &&
    inCallControlLossAgeMs < 5_000 &&
    !leave
  );
${sources.preservedIdentity}
  const meetingEnded = Boolean(
    [...document.querySelectorAll(".zm-modal-body-title")].some((node) =>
      /meeting (?:has been ended by host|has ended)/i.test(text(node))
    ) ||
    (
      inCallControlDisconnected &&
      inCallControlLossAgeMs >= 5_000 &&
      !leave
    )
  );
  const inCall = Boolean(identityVerified && leave && !meetingEnded);
  if (canMutateSession && identityVerified && meetingOwnerConflict) {
    // The tab can survive a Zoom SPA meeting/session change. Old hidden bridges
    // must stop, while their muted source streams remain eligible for the new owner.
    adoptAudioBridgeSourcesForSession();
  }
  if (canMutateSession && !inCall && !identityAwaitingRerender) retireOwnedAudioBridges();
  if (canMutateSession && (identityVerifiedBeforeCall || identityPreservedInCall)) {
    window.__openclawZoomMeeting = {
      ...(priorMeeting?.identity === expectedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      awaitingAdmission: !inCall && lobbyWaiting,
      devicesDisabled,
      ...(inCall ? { inCallControl: leave, inCallControlLostAt: undefined, inCallUrl: location.href } : {}),
    };
  } else if (
    canMutateSession &&
    !currentIdentity &&
    priorMeeting &&
    !identityAwaitingRerender &&
    (
      priorMeeting.inCallControl ||
      (priorMeeting.awaitingAdmission !== true && markerAgeMs >= identityRetentionMs)
    )
  ) {
    delete window.__openclawZoomMeeting;
  }
  const microphone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
  let microphoneState = identityVerified ? (toggleState(microphone, "microphone") || (devicesDisabled ? "off" : undefined)) : undefined;
  const refreshMicrophoneState = async () => {
    await waitForUi();
    const currentMicrophone = first(selectors.microphone) || findTextButton(/mute|unmute|microphone/i);
    microphoneState = toggleState(currentMicrophone, "microphone");
  };
  const camera = first(selectors.camera) || findTextButton(/camera|video/i);
  let cameraState = identityVerified ? (toggleState(camera, "camera") || (devicesDisabled ? "off" : undefined)) : undefined;
  let controlManualAction;
  const passcodeInput = firstRaw(selectors.passcode);
  const passcodeRequired = Boolean(passcodeInput) &&
    /meeting passcode|enter (?:the )?passcode|invalid passcode|incorrect passcode/i.test(
      pageText + " " + label(passcodeInput)
    );
  const captchaRequired = Boolean(firstRaw(selectors.captcha)) ||
    /complete (?:the )?captcha|security check|verify (?:that )?you(?:'re| are) (?:a )?human/i.test(pageTextLower);
  if (identityVerified && !inCall && passcodeRequired) {
    controlManualAction = manualActionFor("zoom-passcode-required", "Enter the Zoom meeting passcode in the OpenClaw browser profile, then retry joining.");
  } else if (identityVerified && !inCall && captchaRequired) {
    controlManualAction = manualActionFor("zoom-captcha-required", "Complete Zoom's security check in the OpenClaw browser profile, then retry joining.");
  }

  if (
    canMutateSession &&
    identityVerified &&
    camera &&
    cameraState === "on" &&
    !controlManualAction
  ) {
    camera.click();
    await waitForUi();
    const continueWithoutCamera = findTextControl(/\\bcontinue without camera\\b/i);
    if (continueWithoutCamera) {
      clickable(continueWithoutCamera)?.click?.();
      await waitForUi();
    }
    const currentCamera = first(selectors.camera) || findTextButton(/camera|video/i);
    cameraState = toggleState(currentCamera, "camera");
    if (cameraState === "off") {
      notes.push(inCall ? "Turned the Zoom camera off after admission." : "Turned the Zoom camera off before joining.");
    }
  }
  const join = first(selectors.join) ||
    findTextButton(/^\\s*(join|join now|ask to join|join meeting)\\s*$/i);
  if (
    identityVerified &&
    (inCall || join) &&
    cameraState !== "off" &&
    !controlManualAction
  ) {
    controlManualAction = manualActionFor("zoom-camera-required", inCall ? "Turn the Zoom camera off and verify the in-call camera control shows it is off." : "Turn the Zoom camera off and verify the camera control shows it is off, then retry joining.");
  }
${sources.virtualAudioInput({
  beforeEnumerationSource: `    const preparedInput = window.__openclawZoomMeeting;
    if (preparedInput?.identity === expectedIdentity && (!sessionId || preparedInput?.sessionId === sessionId)) {
      delete preparedInput.audioInputDeviceId;
    }
`,
  selectionSource: `      let selected = Boolean(selectedMicrophoneLabel());`,
})}
${sources.prejoinMicrophone({
  unroutedSource: `      notes.push("The virtual audio input will be selected from Zoom's in-call audio controls.");`,
  muteInCall: true,
})}
${sources.inCallMicrophone}
  if (
    identityVerified &&
    (inCall || join) &&
    !allowMicrophone &&
    microphoneState !== "off" &&
    !controlManualAction
  ) {
    controlManualAction = manualActionFor("zoom-microphone-required", inCall ? "Mute the Zoom microphone and verify it stays muted for observe-only mode." : "Mute the Zoom microphone and verify the microphone control shows it is off, then retry joining.");
  }`,
    manualActionSource: (sources) => `  const signInControl = first(selectors.signIn);
  const tenantLoginRequired =
    /authorized attendees only|meeting is for authorized attendees|sign in to join|verify your email|enter the code sent to/i.test(pageTextLower);
  const loginRequired = tenantLoginRequired ||
    (Boolean(signInControl) && !guestInput && !join && /sign in to (?:join|continue)|sign in to your account/i.test(pageTextLower));
${sources.manualActions({ inCallControls: true })}`,
    platform: {
      displayName: "Zoom",
      globals: {
        audioOutputs: "__openclawZoomAudioOutputs",
        captionArchive: "__openclawZoomCaptionArchive",
        captions: "__openclawZoomCaptions",
        meeting: "__openclawZoomMeeting",
      },
      manualActionReasonPrefix: "zoom",
    },
    setupSource: `const topDocument = globalThis.document;
  const document = topDocument.querySelector("#webclient")?.contentDocument || topDocument;
  const pageWindow = document.defaultView || globalThis;
  const HTMLInputElement = pageWindow.HTMLInputElement || globalThis.HTMLInputElement;
  const Event = pageWindow.Event || globalThis.Event;
  const MutationObserver = pageWindow.MutationObserver || globalThis.MutationObserver;`,
  });
}
