import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

// Slack updates the channel header shortly after a Join click; until then the new call cannot be proven.
export const SLACK_HUDDLE_JOIN_SETTLE_MS = 30_000;
// Slack's link prompt can briefly read idle while it loads the huddle state.
const SLACK_HUDDLE_IDLE_PROMPT_SETTLE_MS = 3_000;

export const slackHuddleStatusPrelude: Parameters<
  typeof MeetingPlatformAdapter.createPageScripts
>[0]["statusPrelude"] = {
  // Slack renders the huddle preview and in-call controls into an unnamed about:blank window opened
  // from this tab. Only the handle window.open returns reaches it, so every status pass keeps the hook
  // in place before any click that may open the window. Membership stays proven by this tab's header.
  setupSource: `if (typeof window.open === "function" && !window.open.__openclawSlackHuddleCallWindow) {
    const open = window.open;
    const tracked = function (...args) {
      const opened = open.apply(this, args);
      if (opened && String(args[0] ?? "") === "about:blank") window.__openclawSlackHuddleCallWindow = opened;
      return opened;
    };
    tracked.__openclawSlackHuddleCallWindow = true;
    window.open = tracked;
  }
  const slackHuddleCallDocument = () => {
    try {
      const opened = window.__openclawSlackHuddleCallWindow;
      // Slack points the window at its huddle's /client/<team>/<channel>. Channel ids are workspace-scoped,
      // so the window must name exactly the team and channel of this verified tab (which enforces any
      // workspace binding); a window for any other huddle is never used. Cross-origin access throws.
      const clientPath = (href) => new URL(href).pathname.match(/^\\/client\\/[TE][A-Z0-9]{8,}\\/[CGD][A-Z0-9]{8,}/)?.[0];
      const tabPath = clientPath(location.href);
      return opened && !opened.closed && tabPath && meetingIdentity(location.href) === expectedIdentity &&
        clientPath(opened.location.href) === tabPath ? opened.document : undefined;
    } catch {
      return undefined;
    }
  };`,
  controlDocumentsSource: "[slackHuddleCallDocument(), document].filter(Boolean)",
  controlLookupSource: `const findTextButton = (root, pattern) => [...(root?.querySelectorAll("button") || [])]
    .find((button) => !button.disabled && pattern.test(text(button)));
  const unavailable = (node) => !node || node.disabled || node.getAttribute?.("aria-disabled") === "true";
  // The huddle window's preview button is labeled "Join" only by aria-label; the in-tab preview says "Join Huddle".
  const joinLabel = /^join(?: huddle)?$/i;
  const joinText = (node) => text(node) || node?.getAttribute?.("aria-label") || "";`,
  lifecycleSource: `// Slack's desktop-app launcher links to the web client; follow it only to the requested huddle.
  const continueInBrowser = [...document.querySelectorAll(selectors.continueInBrowser.join(","))]
    .find((link) => expectedIdentity && meetingIdentity(link.getAttribute?.("href") || "") === expectedIdentity);
  if (canMutateSession && continueInBrowser) {
    continueInBrowser.click();
    notes.push("Continued from Slack's desktop-app page to the web client.");
    await waitForUi();
  }
  const preview = firstRaw(selectors.preview);
  const join = first(selectors.join) || findTextButton(preview, joinLabel);
  const linkJoinPrompt = firstRaw(selectors.linkJoinPrompt);
  const linkJoin = firstWithin(linkJoinPrompt, selectors.linkJoin);
  const linkHuddleIdle = /no one is in the huddle/i.test(text(linkJoinPrompt));
  // Slack can draw the link prompt before it loads the huddle's state, so an idle reading counts only
  // once that same prompt has stayed idle across passes for a few seconds.
  const idlePrompt = window.__openclawSlackHuddleIdlePrompt;
  const idlePromptSince = linkHuddleIdle && idlePrompt?.prompt === linkJoinPrompt ? idlePrompt.since : Date.now();
  if (canMutateSession) {
    if (linkHuddleIdle) window.__openclawSlackHuddleIdlePrompt = { prompt: linkJoinPrompt, since: idlePromptSince };
    else delete window.__openclawSlackHuddleIdlePrompt;
  }
  const linkHuddleIdleSettled = linkHuddleIdle && Date.now() - idlePromptSince >= ${SLACK_HUDDLE_IDLE_PROMPT_SETTLE_MS};
  const leave = first(selectors.leave);
  const inCallControl = leave || firstRaw(selectors.inCall);
  const huddleSurfaces = controlQueryAll(selectors.huddleSurfaces)
    .filter((node) => node.isConnected !== false && !node.hidden && node.getAttribute?.("hidden") === null &&
      node.getAttribute?.("aria-hidden") !== "true" && node.getClientRects?.().length !== 0);
  const huddleText = huddleSurfaces.map(text).join(" ");
  const lobbyWaiting = huddleSurfaces.some((root) => findTextButton(root, /^request to join$/i)) ||
    /waiting (?:for .* )?(?:to (?:join|let you in)|for approval)|request (?:has been )?sent/i.test(huddleText);
  const sameRecordedIdentity = priorMeeting?.identity === expectedIdentity;
  const identityAwaitingRerender = false;
  const identityVerified = identityVerifiedBeforeCall;
  const confirmation = firstRaw(selectors.confirmation);
  const multiDevice = firstRaw(selectors.multiDevice);
  // Slack keeps a huddle running while the client shows other channels and may reuse its global
  // toolbar, so neither URLs nor call controls prove which huddle is live. Only the viewed channel's
  // header state establishes membership; without it the adapter fails closed.
  const joinSettling = Boolean(sameRecordedIdentity && priorMeeting.joinRequested === true &&
    Date.now() - (priorMeeting.joinRequestedAt || 0) < ${SLACK_HUDDLE_JOIN_SETTLE_MS});
  // Channel ids are workspace-scoped: a channel-only session counts as a member only once bound to its
  // workspace. Binding happens here, before any await; read-only or team-less views cannot bind and
  // fail closed. The page identity then rejects other workspaces.
  const channelOnlySession = Boolean(expectedIdentity && !/^slack-huddle:[TE][A-Z0-9]+:/.test(expectedIdentity));
  const headerMember = identityVerified && Boolean(firstRaw(selectors.channelHeaderInHuddle));
  let workspaceBound = !channelOnlySession || Boolean(window.__openclawSlackHuddleWorkspaces?.[expectedIdentity]);
  // Only a session that owns this page lifetime's marker may bind; after a reload an established
  // session has no marker and fails closed rather than adopting whatever workspace is showing.
  const ownsPageMarker = Boolean(sameRecordedIdentity && priorMeeting.sessionId === sessionId &&
    priorMeeting.bindable === true);
  if (!workspaceBound && headerMember && canMutateSession && ownsPageMarker && inCallControl && !preview &&
      !confirmation && !multiDevice) {
    let pageTeam;
    try {
      pageTeam = new URL(location.href).pathname.match(/^\\/(?:client|huddle)\\/([TE][A-Z0-9]{8,})\\//)?.[1];
    } catch { /* An unparseable page URL cannot establish workspace membership. */ }
    if (pageTeam) {
      (window.__openclawSlackHuddleWorkspaces ||= {})[expectedIdentity] = pageTeam;
      workspaceBound = true;
    }
  }
  const huddleMember = headerMember && workspaceBound;
  let inCall = Boolean(huddleMember && inCallControl && !preview && !confirmation && !multiDevice);
  // Status work awaits permission queries and UI settling, so authority is rechecked right before each
  // click: this session still owns the page marker (and is not leaving), plus the in-call membership
  // header, or the same preview with no other call live.
  const markerOwned = () => {
    const marker = window.__openclawSlackHuddle;
    return !marker || (marker.sessionId === sessionId && !marker.leavePending);
  };
  const authorityHolds = () => meetingIdentity(location.href) === expectedIdentity && markerOwned() &&
    !firstRaw(selectors.confirmation) && !firstRaw(selectors.multiDevice) && (inCall
    ? Boolean(firstRaw(selectors.channelHeaderInHuddle))
    : Boolean(preview && firstRaw(selectors.preview) === preview && !firstRaw(selectors.inCall)));
  let authorityLost = false;
  const act = (node) => {
    if (authorityLost || !authorityHolds()) {
      authorityLost = true;
      return false;
    }
    node.click();
    return true;
  };
  if (canMutateSession && identityVerified && meetingOwnerConflict) adoptAudioBridgeSourcesForSession();
  if (canMutateSession && !inCall) retireOwnedAudioBridges();
  if (canMutateSession && identityVerified) {
    window.__openclawSlackHuddle = {
      ...(sameRecordedIdentity && !meetingOwnerConflict ? priorMeeting : {}),
      identity: expectedIdentity,
      sessionId: sessionId || priorMeeting?.sessionId,
      verifiedAt: Date.now(),
      // Only a marker born before any live call (pre-join, admission, or our own Join) may later bind a
      // workspace; one first written beside an already-live, unbound call never can.
      bindable: (sameRecordedIdentity && !meetingOwnerConflict && priorMeeting.bindable === true) || !inCallControl,
      ...(inCall ? { inCallControl, inCallUrl: location.href, joinRequested: false } : {}),
      ...(!inCall && inCallControl && (confirmation || multiDevice) ? { joinRequested: false } : {}),
    };
  } else if (canMutateSession && priorMeeting && !currentIdentity && !lobbyWaiting) {
    delete window.__openclawSlackHuddle;
  }
  const currentMicrophone = () => preview ? first(selectors.previewMicrophone) : first(selectors.microphone);
  // Read below, after the marker is written; until then a disabled preview microphone counts as on.
  let microphonePermissionState;
  const previewMicrophoneDisabled = () =>
    Boolean(preview) && currentMicrophone()?.getAttribute?.("aria-disabled") === "true";
  const readMicrophone = () => {
    const current = currentMicrophone();
    // Slack disables the preview microphone while Chrome withholds microphone access; only then is a
    // disabled switch that reads on unable to send audio.
    if (previewMicrophoneDisabled() && microphonePermissionState && microphonePermissionState !== "granted") return "off";
    return toggleState(current, "microphone") || (!preview && (
      firstWithin(current, selectors.mutedIcon) ? "off" :
      firstWithin(current, selectors.unmutedIcon) ? "on" : undefined
    ));
  };
  let microphoneState = identityVerified ? readMicrophone() : undefined;
  const camera = firstRaw(['button[role="switch"][aria-label="Camera"]']);
  let cameraState = identityVerified ? (toggleState(camera, "camera") || (!camera ? "off" : undefined)) : undefined;
  const { isVirtualAudioDevice, selectedMicrophoneLabel } = meetingAudioInput;
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  if (identityVerified && allowMicrophone) {
    audioInputDeviceLabel = selectedMicrophoneLabel();
    audioInputRouted = Boolean(audioInputDeviceLabel);
  }
  let manualAction;
  const hostname = location.hostname.toLowerCase();
  const loginPage = (hostname === "slack.com" || /^[a-z0-9-]+\\.slack\\.com$/.test(hostname)) &&
    /^\\/(?:signin|workspace-signin|get-started|check-login|ssb\\/signin)(?:\\/|$)/i.test(location.pathname);
  if ((allowMicrophone || previewMicrophoneDisabled()) && navigator.permissions?.query) {
    try { microphonePermissionState = (await navigator.permissions.query({ name: "microphone" })).state; }
    catch { /* Unsupported permission queries leave permission state unknown. */ }
  }
  if (committedOwnerConflict && !canMutateSession) {
    manualAction = manualActionFor("slack-session-conflict", "This Slack tab is owned by another active huddle session.");
  } else if (!inCall && (loginPage || firstRaw(selectors.signIn))) {
    manualAction = manualActionFor("slack-login-required", "Sign the OpenClaw Chrome profile into Slack as the claw's Slack account, then retry.");
  } else if (!inCall && inCallControl && !confirmation && !multiDevice && !joinSettling) {
    manualAction = manualActionFor("slack-session-conflict", "Slack does not show this account in the requested huddle while another call is live. Leave that huddle or reopen the requested channel, then retry.");
  } else if (multiDevice) {
    manualAction = manualActionFor("slack-session-conflict", "This Slack account is already in a huddle on another device. Resolve the Slack device prompt, then retry.");
  } else if (confirmation) {
    manualAction = manualActionFor("slack-confirmation-required", "Complete the Slack confirmation, then retry: " + text(confirmation));
  } else if (!inCall && lobbyWaiting) {
    manualAction = manualActionFor("slack-admission-required", "Request to join this huddle in Slack and wait for admission, then retry status.");
  } else if (!inCall && ((join && /^start huddle$/i.test(text(join))) || (!preview && linkHuddleIdleSettled))) {
    manualAction = manualActionFor("slack-huddle-not-active", "No one is in this huddle yet. Start the huddle in Slack, then ask again.");
  // Observe-only joins never request the microphone, and only the requested huddle's client page holds
  // the granted origin; the desktop-app launcher on slack.com never does.
  } else if (identityVerified && allowMicrophone && ((microphonePermissionState === "denied" || microphonePermissionState === "prompt") ||
    (!inCall && /allow (?:slack (?:to )?)?(?:access to |use (?:your )?)?(?:the |your )?microphone|microphone permission/i.test(huddleText)))) {
    manualAction = manualActionFor("slack-permission-required", "Allow Slack microphone permission in the OpenClaw Chrome profile, then retry.");
  }
  // Toggle state can change during awaits (a person may mute or unmute), so each toggle re-reads the
  // live control right before clicking and only clicks when the live state differs from the target.
  const currentCamera = () => firstRaw(['button[role="switch"][aria-label="Camera"]']);
  const setMicrophone = async (desired) => {
    const control = currentMicrophone();
    const live = readMicrophone();
    // Unmuting is only safe while Slack still reports the virtual microphone as its selected input.
    const safe = desired !== "on" || Boolean(selectedMicrophoneLabel());
    if (live && live !== desired && safe && !unavailable(control) && act(control)) {
      await waitForUi();
    }
    microphoneState = readMicrophone();
  };
  const ownsCameraScope = inCall || Boolean(preview);
  if (canMutateSession && identityVerified && ownsCameraScope && !manualAction) {
    const control = currentCamera();
    if (toggleState(control, "camera") === "on" && !unavailable(control) && act(control)) {
      await waitForUi();
    }
    cameraState = toggleState(currentCamera(), "camera") || (!currentCamera() ? "off" : undefined);
  }
  // Slack can switch the selected input during awaited work; routing decisions use a fresh read.
  const refreshAudioInput = () => {
    if (identityVerified && allowMicrophone) {
      audioInputDeviceLabel = selectedMicrophoneLabel();
      audioInputRouted = Boolean(audioInputDeviceLabel);
    }
  };
  refreshAudioInput();
  if (canMutateSession && identityVerified && inCall && allowMicrophone && !audioInputRouted && !manualAction) {
    await setMicrophone("off");
    const audioSettings = first(selectors.deviceSettings);
    if (!unavailable(audioSettings) && act(audioSettings)) {
      await waitForUi();
      const choice = controlQueryAll(selectors.audioDeviceOptions)
        .find((node) => isVirtualAudioDevice(text(node)) && !unavailable(node));
      const target = choice ? clickable(choice) : undefined;
      if (target && act(target)) {
        await waitForUi();
      }
      audioInputDeviceLabel = selectedMicrophoneLabel();
      audioInputRouted = Boolean(audioInputDeviceLabel);
    }
  }
  if (canMutateSession && identityVerified && !manualAction && (inCall || (autoJoin && join && joinLabel.test(joinText(join))))) {
    // Always join muted: the Join transition itself can switch Slack's input. Unmute only in the call,
    // once membership is proven and Slack reports the virtual input, so a physical microphone never goes live.
    refreshAudioInput();
    let desiredMicrophoneState = inCall && allowMicrophone && audioInputRouted ? "on" : "off";
    await setMicrophone(desiredMicrophoneState);
    // Muting is safe whatever the input, so one post-check ends the race: if Slack left the virtual
    // input during that await, mute rather than leave a physical microphone live.
    refreshAudioInput();
    if (desiredMicrophoneState === "on" && !audioInputRouted) {
      desiredMicrophoneState = "off";
      await setMicrophone("off");
    }
    if (microphoneState !== desiredMicrophoneState && !authorityLost) {
      manualAction = manualActionFor("slack-microphone-required", !allowMicrophone
        ? "Turn off the Slack huddle microphone for observe-only mode, then retry."
        : desiredMicrophoneState === "on"
          ? "Turn on the Slack huddle microphone, then retry."
          : "Mute the Slack huddle microphone until the OpenClaw virtual microphone is selected, then retry.");
    }
  }
  if (identityVerified && ownsCameraScope && cameraState !== "off" && !manualAction) {
    manualAction = manualActionFor("slack-camera-required", "Turn off the Slack huddle camera, then retry.");
  }
  let clickedJoin = false;
  if (canMutateSession && identityVerified && autoJoin && !inCall && !manualAction && !authorityLost &&
      !unavailable(join) && joinLabel.test(joinText(join))) {
    // Last-moment gate: earlier camera and microphone reads predate awaited work.
    if (!authorityHolds()) {
      authorityLost = true;
    } else if (toggleState(currentCamera(), "camera") === "on") {
      manualAction = manualActionFor("slack-camera-required", "Turn off the Slack huddle camera, then retry.");
    } else if (readMicrophone() === "on") {
      manualAction = manualActionFor("slack-microphone-required", "Mute the Slack huddle microphone before joining, then retry.");
    } else {
      window.__openclawSlackHuddle.joinRequested = true;
      window.__openclawSlackHuddle.joinRequestedAt = Date.now();
      join.click();
      clickedJoin = true;
      notes.push("Clicked Join Huddle for an active Slack huddle.");
    }
  }
  // The link prompt only opens Slack's huddle window; the next pass joins muted from its preview.
  if (canMutateSession && identityVerified && autoJoin && !inCall && !inCallControl && !preview && !manualAction &&
      !authorityLost && !linkHuddleIdle && !unavailable(linkJoin) && joinLabel.test(text(linkJoin))) {
    if (meetingIdentity(location.href) === expectedIdentity && markerOwned() &&
        firstRaw(selectors.linkJoinPrompt) === linkJoinPrompt && !firstRaw(selectors.inCall) &&
        !firstRaw(selectors.confirmation) && !firstRaw(selectors.multiDevice)) {
      linkJoin.click();
      notes.push("Opened Slack's huddle window from the huddle link prompt.");
    } else {
      authorityLost = true;
    }
  }
  // Everything reported after this point (captions, audio, metadata) reflects the huddle at return time.
  if (inCall && !authorityHolds()) {
    inCall = false;
    authorityLost = true;
  }
  // A workspace binding ends only on proven departure: this session's own channel view (the identity
  // enforces the bound workspace) shows this device out of the huddle.
  if (canMutateSession && channelOnlySession && !inCallControl && !joinSettling &&
      meetingIdentity(location.href) === expectedIdentity &&
      firstRaw(selectors.channelHeader) && !firstRaw(selectors.channelHeaderInHuddle)) {
    delete window.__openclawSlackHuddleWorkspaces?.[expectedIdentity];
  }
  if (authorityLost) {
    notes.push("Slack huddle state changed during status; later controls were left untouched.");
    const promptNow = firstRaw(selectors.multiDevice) || firstRaw(selectors.confirmation);
    if (!manualAction && promptNow) {
      manualAction = firstRaw(selectors.multiDevice)
        ? manualActionFor("slack-session-conflict", "This Slack account is already in a huddle on another device. Resolve the Slack device prompt, then retry.")
        : manualActionFor("slack-confirmation-required", "Complete the Slack confirmation, then retry: " + text(promptNow));
    }
  }`,
  manualActionSource: "",
};
