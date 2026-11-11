import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { inspectFaceTimeDriver } from "./driver-setup.js";
import { resolveFaceTimeDialRequest } from "./outbound-call.js";

export type FaceTimeClickToCallOutcome = {
  placed: boolean;
  live: boolean;
  detail: string;
};

/**
 * macOS 26/27 does not place a FaceTime call from the facetime:// URL scheme.
 * It opens the Phone app "Click to Call" contact card in Notification Center,
 * and the phone only rings once that card's Call button is pressed.
 *
 * The Call button is an AXButton whose AX name is empty on current macOS while
 * its AX description reads "Call", so a matcher that only reads the name never
 * finds it. Match either attribute.
 */
const CLICK_TO_CALL_SCRIPT = `on findLiveCall()
  set processNames to {"NotificationCenter", "UserNotificationCenter", "Phone", "FaceTime"}
  repeat with pn in processNames
    set pname to pn as text
    try
      tell application "System Events"
        tell process pname
          repeat with wn in windows
            try
              set elems to entire contents of wn
              repeat with e in elems
                try
                  if (role of e) is "AXStaticText" then
                    set v to (value of e) as text
                    if v starts with "FaceTime Audio - " then
                      return v
                    end if
                  end if
                end try
              end repeat
            end try
          end repeat
        end tell
      end tell
    end try
  end repeat
  return ""
end findLiveCall

on run
  set processNames to {"NotificationCenter", "UserNotificationCenter", "Phone", "FaceTime"}
  set existing to findLiveCall()
  if existing is not "" then return "ALREADY_LIVE:" & existing
  set pressed to false
  tell application "System Events"
    repeat 20 times
      repeat with pn in processNames
        set pname to pn as text
        try
          tell process pname
            set bestY to 99999
            set found to missing value
            repeat with wn in windows
              try
                set elems to entire contents of wn
                repeat with e in elems
                  try
                    if (role of e) is "AXButton" then
                      set dd to ""
                      try
                        set dd to (description of e) as text
                      end try
                      set nn to ""
                      try
                        set nn to (name of e) as text
                      end try
                      if (dd is "Call" or nn is "Call") then
                        set pp to position of e
                        set py to item 2 of pp
                        if py < bestY then
                          set bestY to py
                          set found to e
                        end if
                      end if
                    end if
                  end try
                end repeat
              end try
            end repeat
            if found is not missing value then
              try
                perform action "AXPress" of found
                set pressed to true
              end try
            end if
          end tell
        end try
        if pressed then exit repeat
      end repeat
      if pressed then exit repeat
      delay 0.5
    end repeat
    if not pressed then return "NOT_FOUND"
    repeat 60 times
      repeat with pn in processNames
        set pname to pn as text
        try
          tell process pname
            repeat with wn in windows
              try
                set elems to entire contents of wn
                repeat with e in elems
                  try
                    if (role of e) is "AXStaticText" then
                      set v to (value of e) as text
                      if v starts with "FaceTime Audio - " then
                        return "LIVE:" & v
                      end if
                    end if
                  end try
                end repeat
              end try
            end repeat
          end tell
        end try
      end repeat
      delay 0.5
    end repeat
    return "PLACED_NOT_LIVE"
  end tell
end run
`;

/** macOS renders the click-to-call card asynchronously after the URL opens. */
const CLICK_TO_CALL_SETTLE_MS = 5_000;

export function buildFaceTimeCallUrl(handle: string, mode: "audio" | "video"): string {
  const scheme = mode === "video" ? "facetime" : "facetime-audio";
  return `${scheme}://${encodeURIComponent(handle)}`;
}

export function parseClickToCallOutcome(output: string): FaceTimeClickToCallOutcome {
  const trimmed = output.trim();
  if (trimmed.startsWith("ALREADY_LIVE:")) {
    return {
      placed: false,
      live: true,
      detail: `a FaceTime call is already live (${trimmed.slice("ALREADY_LIVE:".length)})`,
    };
  }
  if (trimmed.startsWith("LIVE:")) {
    return { placed: true, live: true, detail: trimmed.slice("LIVE:".length) };
  }
  if (trimmed === "PLACED_NOT_LIVE") {
    return {
      placed: true,
      live: false,
      detail: "call placed, but the carrier did not report a live call",
    };
  }
  return {
    placed: false,
    live: false,
    detail: trimmed || "no output from the click-to-call helper",
  };
}

/**
 * Places an outbound FaceTime call through the macOS click-to-call card.
 *
 * The handle must resolve to an authorized owner handle; only owner handles
 * may place or receive bridged calls.
 *
 * This carrier does not use the native helper, so it cannot prove a muted
 * carrier the way `resolveFaceTimeDialResult` does. The audio driver is the
 * isolation boundary instead: with the driver current and `OpenClaw-Mic`
 * selected as the call microphone, the call carries the agent feed rather than
 * the room microphone. A missing or outdated driver is refused rather than
 * placing a call without that isolation.
 */
export async function placeClickToCallCarrier(params: {
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  ownerHandles: readonly string[];
  handle: unknown;
  mode?: unknown;
  pluginRoot: string;
}): Promise<FaceTimeClickToCallOutcome> {
  const request = resolveFaceTimeDialRequest({
    handle: params.handle,
    mode: params.mode,
    ownerHandles: params.ownerHandles,
  });
  const driverStatus = await inspectFaceTimeDriver({
    pluginRoot: params.pluginRoot,
    runCommandWithTimeout: params.runCommandWithTimeout,
  });
  if (driverStatus !== "current") {
    return {
      placed: false,
      live: false,
      detail: `FaceTime audio driver is ${driverStatus}; install it before placing a call`,
    };
  }
  const opened = await params.runCommandWithTimeout(
    ["/usr/bin/open", buildFaceTimeCallUrl(request.handle, request.mode)],
    { timeoutMs: 10_000 },
  );
  if (opened.code !== 0) {
    return {
      placed: false,
      live: false,
      detail: opened.stderr?.trim() || opened.stdout?.trim() || `open exit ${opened.code}`,
    };
  }
  await sleep(CLICK_TO_CALL_SETTLE_MS);
  const result = await params.runCommandWithTimeout(
    ["/usr/bin/osascript", "-e", CLICK_TO_CALL_SCRIPT],
    { timeoutMs: 90_000 },
  );
  if (result.code !== 0) {
    return {
      placed: false,
      live: false,
      detail: result.stderr?.trim() || `osascript exit ${result.code}`,
    };
  }
  return parseClickToCallOutcome(result.stdout || "");
}
