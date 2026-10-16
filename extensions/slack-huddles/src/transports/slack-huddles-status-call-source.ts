import type { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

export const slackHuddleStatusCall: Parameters<
  typeof MeetingPlatformAdapter.createPageScripts
>[0]["statusCall"] = {
  liveOwnershipSource: "authorityHolds()",
  // Shared routing awaits device work after the prelude's checks: re-verify membership and never
  // leave the microphone live on an input that is no longer the virtual device.
  afterAudioRoutingSource: `if (inCall && !authorityHolds()) inCall = false;
  if (inCall && allowMicrophone) {
    refreshAudioInput();
    if (canMutateSession && !audioInputRouted && readMicrophone() === "on") await setMicrophone("off");
  }`,
  // Shared status work awaits device routing before captions; recheck membership before scraping.
  captionEnableSource: `if (inCall && !authorityHolds()) {
      inCall = false;
      notes.push("Slack huddle membership changed during status; captions were not collected.");
    }
    if (inCall && captureCaptions && !captionsEnabledNow) {
      notes.push("Slack captions are off or not visible. Enable the Slack preference to turn on captions by default when joining huddles.");
    }`,
  // The shared result lists inCall before this block; the later key wins, so the reported call and
  // its global title/participants reflect membership as of return, after shared awaited work.
  extraResultSource: `inCall: inCall && authorityHolds(),
    meetingTitle: inCall && authorityHolds() ? text(firstRaw(selectors.title)) || undefined : undefined,
    participantCount: inCall && authorityHolds()
      ? new Set(selectors.participants.flatMap((selector) => [...document.querySelectorAll(selector)])).size
      : undefined,`,
};
