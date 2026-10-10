// Google Meet owns its DOM selectors and in-page automation scripts.
import {
  createMeetingBrowserAudioCaptureSource,
  type MeetingBrowserAudioCaptureRequest,
} from "openclaw/plugin-sdk/meeting-page-script-runtime";
import { GOOGLE_MEET_CAPTION_OBSERVER_SOURCE } from "./google-meet-caption-observer-source.js";
import { normalizeMeetUrlForReuse } from "./google-meet-urls.js";

export function meetAudioCaptureScript(params: MeetingBrowserAudioCaptureRequest): string {
  return createMeetingBrowserAudioCaptureSource({
    ...params,
    ownershipSource: `
      const expectedUrl = ${JSON.stringify(normalizeMeetUrlForReuse(params.meetingUrl))};
      const currentUrl = new URL(location.href);
      return Boolean(expectedUrl && window.__openclawMeetAudioSession === sessionId &&
        currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/[/]$/, "") === expectedUrl &&
        [...document.querySelectorAll("button")].some((button) =>
          /leave call/i.test(button.getAttribute("aria-label") || button.textContent || "")));
    `,
  });
}

export function meetStatusScript(params: {
  allowMicrophone: boolean;
  autoJoin: boolean;
  captionSessionId?: string;
  captureCaptions: boolean;
  guestName: string;
  readOnly?: boolean;
}) {
  return `async () => {
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const manualActionFor = (reason, message) => ({ reason, message });
  const allowMicrophone = ${JSON.stringify(params.allowMicrophone)};
  const captionSessionId = ${JSON.stringify(params.captionSessionId)};
  const captureCaptions = ${JSON.stringify(params.captureCaptions)};
  const readOnly = ${JSON.stringify(Boolean(params.readOnly))};
  const buttons = () => [...document.querySelectorAll('button')];
  const buttonLabel = (button) =>
    [
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      text(button),
    ]
      .filter(Boolean)
      .join(" ");
  const buttonLabels = buttons().map(buttonLabel).filter(Boolean);
  const notes = [];
  let audioInputRouted;
  let audioInputDeviceLabel;
  let audioInputRouteError;
  let audioOutputRouted;
  let audioOutputDeviceLabel;
  let audioOutputRouteError;
  const findButton = (pattern) =>
    buttons().find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !button.disabled;
    });
  const findCallControlButton = (pattern) =>
    buttons().find((button) => {
      const label = buttonLabel(button);
      return pattern.test(label) && !/remotely mute|someone else/i.test(label) && !button.disabled;
    });
  const audioDeviceFamily = (value) => {
    const label = String(value || '');
    if (/\\bOpenClaw Meeting Audio\\b/i.test(label)) return 'openclaw-meeting-audio';
    if (/\\bBlackHole\\s+2ch\\b/i.test(label)) return 'blackhole-2ch';
    return undefined;
  };
  const isMeetingAudioDevice = (value) => Boolean(audioDeviceFamily(value));
  const deviceNodeLabel = (node) => [
    node?.getAttribute?.('aria-label'),
    node?.getAttribute?.('data-tooltip'),
    node?.getAttribute?.('title'),
    node?.label,
    node?.textContent,
    node?.innerText,
  ].filter(Boolean).join(' ').trim();
  const waitForUi = () => new Promise((resolve) => setTimeout(resolve, 100));
  const input = [...document.querySelectorAll('input')].find((el) =>
    /your name/i.test(el.getAttribute('aria-label') || el.placeholder || '')
  );
  if (!readOnly && ${JSON.stringify(params.autoJoin)} && input && !input.value) {
    input.focus();
    input.value = ${JSON.stringify(params.guestName)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const pageText = text(document.body).toLowerCase();
  const permissionText = [pageText, ...buttonLabels].join("\\n");
  const host = location.hostname.toLowerCase();
  const pageUrl = location.href;
  const permissionNeeded = /permission needed|microphone problem|speaker problem|allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera|speaker)/i.test(permissionText);
  let mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i);
  if (!mic) {
    const callControls = document.querySelector('[role="region"][aria-label="Call controls"]');
    mic = [...(callControls?.querySelectorAll('button') || [])].find((button) =>
      /^\\s*turn (?:off|on) microphone\\b/i.test(buttonLabel(button))
    );
  }
  const joinElsewhere = findButton(/join here too/i);
  const microphoneChoice = findButton(/\\buse microphone\\b/i);
  const noMicrophoneChoice = findButton(/\\b(continue|join|use) without (microphone|mic)\\b|\\bnot now\\b/i);
  if (!readOnly && allowMicrophone && microphoneChoice) {
    microphoneChoice.click();
    notes.push("Accepted Meet microphone prompt with browser automation.");
    await waitForUi();
  } else if (!readOnly && !allowMicrophone && noMicrophoneChoice) {
    noMicrophoneChoice.click();
    notes.push("Skipped Meet microphone prompt for observe-only mode.");
    await waitForUi();
  }
  const findMicrophoneDeviceControl = () => {
    const selectors = [
      'select[aria-label*="microphone" i]',
      'select[name*="microphone" i]',
      '[role="combobox"][aria-label*="microphone" i]',
      '[role="listbox"][aria-label*="microphone" i]',
      '[aria-haspopup="listbox"][aria-label*="microphone" i]',
    ];
    for (const selector of selectors) {
      const control = document.querySelector(selector);
      if (control) return control;
    }
    return undefined;
  };
  const selectedMicrophoneLabel = () => {
    const control = findMicrophoneDeviceControl();
    const nativeSelected = control?.selectedOptions?.[0];
    if (nativeSelected && isMeetingAudioDevice(deviceNodeLabel(nativeSelected))) {
      return deviceNodeLabel(nativeSelected);
    }
    const controlledId = control?.getAttribute?.('aria-controls');
    const optionsRoot = controlledId ? document.getElementById?.(controlledId) : control;
    const selected = [...(optionsRoot?.querySelectorAll?.(
      '[role="option"][aria-selected="true"], [role="menuitemradio"][aria-checked="true"], [role="radio"][aria-checked="true"]'
    ) || [])].find((node) => isMeetingAudioDevice(deviceNodeLabel(node)));
    if (selected) return deviceNodeLabel(selected);
    const role = control?.getAttribute?.('role');
    if (
      !control?.options &&
      role !== 'listbox' &&
      control &&
      isMeetingAudioDevice(deviceNodeLabel(control))
    ) {
      return deviceNodeLabel(control);
    }
    return undefined;
  };
  const openMicrophoneDeviceSettings = async () => {
    if (findMicrophoneDeviceControl()) return;
    const candidates = () => [
      ...document.querySelectorAll('button, [role="menuitem"], [role="tab"]'),
    ];
    const direct = candidates().find((node) =>
      /\\b(?:audio|microphone|device) settings\\b/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    let settings = direct || candidates().find((node) =>
      /^\\s*settings\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    if (!settings && !readOnly) {
      const moreOptions = candidates().find((node) =>
        /^\\s*more options\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
      );
      if (moreOptions) {
        moreOptions.click();
        await waitForUi();
        settings = candidates().find((node) =>
          /^\\s*settings\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
        );
      }
    }
    if (!settings || readOnly) return;
    settings.click();
    await waitForUi();
    const audioTab = [...document.querySelectorAll('button, [role="tab"]')].find((node) =>
      /^\\s*audio\\s*$/i.test(deviceNodeLabel(node)) && !node.disabled
    );
    if (audioTab) {
      audioTab.click();
      await waitForUi();
    }
  };
  const routeMeetAudioInput = async () => {
    if (
      !allowMicrophone ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.enumerateDevices
    ) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const input = devices.find((device) =>
        device.kind === 'audioinput' && isMeetingAudioDevice(device.label)
      );
      if (!input?.deviceId) {
        audioInputRouted = false;
        audioInputRouteError = 'A supported virtual microphone was not visible to Meet.';
        return;
      }
      audioInputDeviceLabel = input.label || 'OpenClaw meeting audio';
      const inputFamily = audioDeviceFamily(audioInputDeviceLabel);
      if (audioDeviceFamily(selectedMicrophoneLabel()) === inputFamily) {
        audioInputRouted = true;
        return;
      }
      if (readOnly) {
        audioInputRouted = false;
        return;
      }
      await openMicrophoneDeviceSettings();
      const control = findMicrophoneDeviceControl();
      if (!control) {
        audioInputRouted = false;
        audioInputRouteError = 'Meet microphone device selector was not available.';
        return;
      }
      const nativeOptions = [...(control.options || [])];
      const nativeOption = nativeOptions.find(
        (option) => audioDeviceFamily(deviceNodeLabel(option)) === inputFamily
      );
      if (nativeOption) {
        control.value = nativeOption.value;
        nativeOption.selected = true;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        control.click?.();
        await waitForUi();
        const choices = [...document.querySelectorAll(
          '[role="option"], [role="menuitemradio"], [role="radio"]'
        )];
        const choice = choices.find(
          (node) => audioDeviceFamily(deviceNodeLabel(node)) === inputFamily && !node.disabled
        );
        choice?.click?.();
      }
      await waitForUi();
      audioInputRouted = audioDeviceFamily(selectedMicrophoneLabel()) === inputFamily;
      if (audioInputRouted) {
        notes.push(\`Selected \${audioInputDeviceLabel} as the Meet microphone.\`);
      } else {
        audioInputRouteError = \`Meet did not confirm \${audioInputDeviceLabel} as its microphone.\`;
      }
    } catch (error) {
      audioInputRouted = false;
      audioInputRouteError = error?.message || String(error);
      notes.push(\`Could not select the Meet virtual microphone: \${audioInputRouteError}\`);
    }
  };
  await routeMeetAudioInput();
  mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i) || mic;
  if (
    !readOnly &&
    allowMicrophone &&
    audioInputRouted !== true &&
    mic &&
    /turn off microphone/i.test(buttonLabel(mic))
  ) {
    mic.click();
    notes.push("Muted the Meet microphone because the virtual audio input was not verified.");
    mic = findCallControlButton(/^\\s*turn (?:off|on) microphone\\b/i) || mic;
  }
  if (!readOnly && allowMicrophone && audioInputRouted === true && mic && /turn on microphone/i.test(buttonLabel(mic))) {
    mic.click();
    notes.push("Turned on the Meet microphone after verifying the virtual audio input.");
  }
  if (!readOnly && !allowMicrophone && mic && /turn off microphone/i.test(mic.getAttribute('aria-label') || text(mic))) {
    mic.click();
    notes.push("Muted Meet microphone for observe-only mode.");
  }
  const join = !readOnly && ${JSON.stringify(params.autoJoin)}
    ? findButton(/join now|ask to join/i)
    : null;
  if (join) join.click();
  const inCall = buttons().some((button) => /leave call/i.test(button.getAttribute('aria-label') || text(button)));
  if (!readOnly && inCall && captionSessionId) {
    const activeCapture = window.__openclawMeetingRemoteAudio;
    if (activeCapture && activeCapture.sessionId !== captionSessionId) {
      return JSON.stringify({ inCall: false, manualAction: manualActionFor("meet-session-conflict", "This Meet tab belongs to another active audio session."), url: location.href, notes });
    }
    window.__openclawMeetAudioSession = captionSessionId;
  }
  const routeMeetAudioOutput = async () => {
    const remoteCapture = window.__openclawMeetingRemoteAudio;
    if (remoteCapture && remoteCapture.sessionId === captionSessionId && remoteCapture.isCurrent()) {
      if (!readOnly) remoteCapture.scan();
      audioOutputRouted = remoteCapture.isCurrent();
      audioOutputDeviceLabel = "Isolated browser playback";
      return;
    }
    if (
      !allowMicrophone ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.enumerateDevices
    ) return;
    const mediaElements = [...document.querySelectorAll('audio, video')]
      .filter((el) => typeof el.setSinkId === 'function');
    if (mediaElements.length === 0) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputFamily = audioDeviceFamily(audioInputDeviceLabel);
      const output = devices.find((device) =>
        device.kind === 'audiooutput' &&
        inputFamily &&
        audioDeviceFamily(device.label) === inputFamily
      ) || devices.find((device) =>
        device.kind === 'audiooutput' && isMeetingAudioDevice(device.label)
      );
      if (!output?.deviceId) {
        audioOutputRouted = false;
        if (devices.some((device) => device.kind === 'audiooutput')) {
          notes.push("A supported virtual speaker output was not visible to Meet.");
        }
        return;
      }
      let routed = 0;
      for (const element of mediaElements) {
        if (element.sinkId !== output.deviceId) {
          if (readOnly) {
            continue;
          }
          await element.setSinkId(output.deviceId);
          routed += 1;
        }
      }
      audioOutputRouted = mediaElements.some((element) => element.sinkId === output.deviceId);
      audioOutputDeviceLabel = output.label || "OpenClaw meeting audio";
      if (!readOnly && audioOutputRouted) {
        notes.push(
          routed > 0
            ? \`Routed Meet media output to \${audioOutputDeviceLabel}.\`
            : \`Meet media output already routed to \${audioOutputDeviceLabel}.\`
        );
      }
    } catch (error) {
      audioOutputRouted = false;
      audioOutputRouteError = error?.message || String(error);
      notes.push(\`Could not route Meet speaker output to the virtual audio device: \${audioOutputRouteError}\`);
    }
  };
  if (inCall) {
    await routeMeetAudioOutput();
  }
  ${GOOGLE_MEET_CAPTION_OBSERVER_SOURCE}
  const lobbyWaiting = !inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText);
  const leaveReason = !inCall && /you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i.test(pageText)
    ? pageText.match(/you left the meeting|you.?ve left the meeting|removed from the meeting|you were removed|call ended|meeting ended/i)?.[0]
    : undefined;
  let manualAction;
  if (!inCall && (host === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText))) {
    manualAction = manualActionFor("google-login-required", "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.");
  } else if (!inCall && joinElsewhere) {
    manualAction = manualActionFor("meet-session-conflict", "Meet is already active in another tab or device. Leave that session or reuse an English-pinned tab before retrying.");
  } else if (!inCall && /asking to be let in|you.?ll join when someone lets you in|waiting to be let in|ask to join/i.test(pageText)) {
    manualAction = manualActionFor("meet-admission-required", "Admit the OpenClaw browser participant in Google Meet, then retry speech.");
  } else if (permissionNeeded) {
    manualAction = manualActionFor("meet-permission-required", allowMicrophone ? "Allow microphone/camera/speaker permissions for Meet in the OpenClaw browser profile, then retry." : "Join without microphone/camera permissions in the OpenClaw browser profile, then retry.");
  } else if (inCall && allowMicrophone && (audioInputRouted !== true || audioOutputRouted !== true)) {
    manualAction = manualActionFor(
      "meet-audio-choice-required",
      "Select BlackHole 2ch or OpenClaw Meeting Audio as both the Meet microphone and speaker, then retry."
    );
  } else if (!inCall && (allowMicrophone ? !microphoneChoice : !noMicrophoneChoice) && /do you want people to hear you in the meeting/i.test(pageText)) {
    manualAction = manualActionFor("meet-audio-choice-required", allowMicrophone ? "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry." : "Meet is showing the microphone choice. Choose the no-microphone option in the OpenClaw browser profile, then retry.");
  }
  return JSON.stringify({
    clickedJoin: Boolean(join),
    clickedMicrophoneChoice: Boolean(allowMicrophone && microphoneChoice),
    inCall,
    micMuted: mic ? /turn on microphone/i.test(buttonLabel(mic)) : undefined,
    lobbyWaiting,
    leaveReason,
    captioning,
    captionsEnabledAttempted,
    transcriptLines,
    lastCaptionAt,
    lastCaptionSpeaker,
    lastCaptionText,
    recentTranscript,
    audioInputRouted,
    audioInputDeviceLabel,
    audioInputRouteError,
    audioOutputRouted,
    audioOutputDeviceLabel,
    audioOutputRouteError,
    manualAction,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}

export function meetLeaveScript(meetingUrl: string) {
  const expectedMeetingUrl = normalizeMeetUrlForReuse(meetingUrl);
  return `() => {
  const expectedMeetingUrl = ${JSON.stringify(expectedMeetingUrl)};
  let currentMeetingUrl;
  try {
    const currentUrl = new URL(location.href);
    currentMeetingUrl = currentUrl.origin + currentUrl.pathname.toLowerCase().replace(/\\/$/, "");
  } catch {
    return JSON.stringify({ departed: false });
  }
  if (!expectedMeetingUrl) {
    return JSON.stringify({ departed: false });
  }
  if (currentMeetingUrl !== expectedMeetingUrl) {
    return JSON.stringify({ departed: true, urlMatched: false });
  }
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  // Locale-independent fallback: Meet renders the leave control as a Material
  // Symbols icon whose ligature text is "call_end" in every UI language, so a
  // localized aria-label (e.g. "Anruf verlassen") still resolves to the button.
  const hasLeaveIcon = (button) => {
    const icon = button.querySelector ? button.querySelector("i") : null;
    return icon ? (icon.textContent || "").trim() === "call_end" : false;
  };
  const buttons = [...document.querySelectorAll('button')];
  const label = (button) => [
    button.getAttribute("aria-label"),
    button.getAttribute("data-tooltip"),
    text(button),
  ]
    .filter(Boolean)
    .join(" ");
  const postCall = buttons.some((button) => /\\b(rejoin|return to home screen)\\b/i.test(label(button)));
  if (postCall) {
    return JSON.stringify({ departed: true, urlMatched: true });
  }
  // Managed join tabs are reused only after the English-tab gate or opened
  // through the English-UI helper, so follow-up labels are pinned to English.
  const confirmation = buttons.find((button) => {
    return !button.disabled && /\\bleave meeting\\b/i.test(label(button));
  });
  if (confirmation) {
    confirmation.click();
    return JSON.stringify({ departed: false, leaveAction: "confirm", urlMatched: true });
  }
  const leave = buttons.find((button) => {
    if (button.disabled) return false;
    return /leave call/i.test(label(button)) || hasLeaveIcon(button);
  });
  if (leave) {
    leave.click();
    return JSON.stringify({ departed: false, leaveAction: "leave", urlMatched: true });
  }
  return JSON.stringify({ departed: false, urlMatched: true });
}`;
}
