# FaceTime vision and avatar: test plan

Design: [vision-and-avatar.md](vision-and-avatar.md).

## What automated checks cover

```bash
node scripts/run-vitest.mjs extensions/facetime
node scripts/run-vitest.mjs src/talk/session-runtime.test.ts
node scripts/run-vitest.mjs extensions/openai/realtime-voice-bridge-events.test.ts
(cd extensions/facetime && npm pack --dry-run)
```

None of these place a call, touch FaceTime, capture a screen, or open a browser.

One live check talks to OpenAI and nothing else. It needs `OPENAI_API_KEY` and costs
a fraction of a cent:

```bash
pnpm test:live -- extensions/openai/realtime-voice-provider.live.test.ts -t "describes an image"
```

It sends a small JPEG through the real bridge to `gpt-realtime-2.1-mini` and passes
only when the spoken answer names the image's left and right colors in order. It
passed on 2026-11-26. The runner copies provider auth from the local OpenClaw state
directory; point `OPENCLAW_STATE_DIR` at an empty directory to keep it away from a
live install.

| Behavior                                                                                    | Proof                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Both features are off unless enabled                                                        | `tests/config.test.ts`                                          |
| Helper is started without credentials; records split across pipe chunks become frames       | `tests/video-capture.test.ts`                                   |
| Stale frames, a vanished call window, and bad records never reach the model                 | `tests/video-capture.test.ts`                                   |
| The look tool attaches the frame before answering, and never puts pixels in Talk events     | `tests/talk-driver.vision.test.ts`                              |
| A model that cannot see, or a missing helper, leaves the call audio-only with no tool       | `tests/talk-driver.vision.test.ts`                              |
| Vision readiness shows in preflight and cannot fail it                                      | `tests/preflight.test.ts`                                       |
| OpenAI realtime receives `input_image` and no response request; nothing is sent after close | `extensions/openai/realtime-voice-bridge-events.test.ts`        |
| A session forwards images only while open and only to a provider that takes them            | `src/talk/session-runtime.test.ts`                              |
| `gpt-realtime-2.1-mini` accepts a JPEG and describes it                                     | `extensions/openai/realtime-voice-provider.live.test.ts` (live) |
| Observers learn when the caller hears each chunk, and when queued speech is discarded       | `tests/audio-pump.test.ts`                                      |
| Silence, back vowels, front vowels, hiss, and loudness map to distinct mouth shapes         | `tests/avatar-lipsync.test.ts`                                  |
| The page is served with a no-external-load policy; viewers get state, shapes, and clear     | `tests/avatar-feed.test.ts` (real loopback HTTP and WebSocket)  |
| The feed is view-only and refuses proxied requests                                          | `tests/avatar-feed.test.ts`                                     |
| The package ships the avatar page and still contains no native binary                       | `tests/package-manifest.test.ts`                                |

## What only a live call can prove

Nothing below was run as part of this change. Each item needs an approval listed in
the next section.

- A real FaceTime call window is captured, scaled, and delivered as frames. The
  helper's scaling, JPEG encoding, and record framing are covered by its own checks
  with synthetic images; its ScreenCaptureKit path has only been run to
  `window unavailable`.
- The model describes a real call frame correctly. The live check above proves it
  accepts and reads a JPEG, with a synthetic two-color image.
- How long a look takes on a call, and what it costs.
- OBS renders the avatar page and FaceTime shows it to the caller.
- Lip sync lines up with the audio the caller hears, and at which `offsetMs`.
- Gateway CPU and thermal load with capture and OBS running through a long call.

## Approvals needed before live enablement

Each is a decision for the Mac's owner. Nothing here was done.

1. **Run a Gateway build that contains this change.** Vision needs the new
   `sendImage` seam in the host and in the bundled OpenAI plugin, not only a newer
   `@openclaw/facetime`. The live install runs released packages; this branch is not
   released.
2. **Install a native package that includes `facetime-video-capture`.** That means
   either an upstream change to `openclaw/openclaw-facetime` plus a signed, notarized
   release and `brew upgrade openclaw-facetime`, or a locally built binary placed in
   the native package's `libexec` directory. Both replace or add to the live native
   helper install.
3. **Screen Recording for the Gateway's responsible process.** ScreenCaptureKit
   access is attributed to the process that launched the Gateway. It is already
   granted to `/bin/sh` on this Mac; macOS may still show a new or recurring prompt
   the first time a window is captured. Check with steps 2 and 3 of the vision run
   below before a call.
4. **OBS scene change.** Replace the static placeholder with a browser source that
   points at the avatar page. The virtual camera stays as FaceTime's video input.
5. **Config change and Gateway restart.** Set `vision.enabled` and `avatar.enabled`
   under `plugins.entries.facetime.config`, then restart the Gateway.
6. **Frames go to the realtime provider.** With vision on, each look sends one frame
   of the call window, which can show the caller's face and anything they share, to
   OpenAI. Leave debug proxy capture off; it would record those frames to disk.
7. **Upstream.** OpenClaw asks for a feature issue before a feature PR. Opening that
   issue, and a PR to `openclaw/openclaw-facetime`, are separate decisions.

No model weights, GPU budget, new third-party account, driver change, SIP change, or
system extension is needed for either feature.

## Live verification

Run these on the Mac, in order. Stop at the first step that fails; each later step
depends on the earlier ones. Vision and avatar are independent and can be run alone.

### Avatar, without a call

1. Set `plugins.entries.facetime.config.avatar.enabled` to `true` and restart the
   Gateway.
2. In a browser on the Mac, open
   `http://127.0.0.1:<gateway port>/facetime/avatar?demo=1`. The default port is
   `18789`.
   Expected: the character breathes, blinks, and talks in bursts.
3. Open the same URL without `?demo=1`.
   Expected: the character is dimmed and silent, still breathing and blinking.
4. From another machine, request `http://<mac address>:<gateway port>/facetime/avatar`.
   Expected: `403 Forbidden`, or no route if the Gateway only listens on loopback.
5. In OBS, add a **Browser** source: URL
   `http://127.0.0.1:<gateway port>/facetime/avatar`, width 1280, height 720, 30 FPS.
   Turn off "Shutdown source when not visible". Hide or remove the static placeholder.
   Expected: the idle character fills the OBS preview.
6. Confirm OBS Virtual Camera is started and FaceTime's video input is still the OBS
   camera.

### Avatar, on a call

7. Call the agent with FaceTime video from an allowed handle.
   Expected: the caller sees the character brighten when the call connects and its
   mouth move while the agent speaks.
8. Interrupt the agent mid-sentence.
   Expected: the mouth closes at once.
9. Watch lip sync. If the mouth leads or trails the voice, add `&offsetMs=<n>` to the
   OBS source URL: positive delays the mouth, negative advances it. Try steps of 50.
   Record the value that works.
10. End the call.
    Expected: the character dims back to idle within a second.

### Vision, without a call

1. Confirm the native package has the helper:
   `ls "$(brew --prefix openclaw-facetime)/libexec/facetime-video-capture"`.
2. In the session that runs the Gateway, run `launchctl managername`.
   Expected: `Aqua`. A Gateway started over SSH or from a background session prints
   `Background`; there ScreenCaptureKit lists windows without their owning apps, so
   the helper reports `window unavailable` for the whole call even though step 3
   passes. This was observed while building this change.
3. Run `"$(brew --prefix openclaw-facetime)/libexec/facetime-video-capture" --check`
   in that same session.
   Expected: a `ready` line and exit status 0. It never prompts. A non-zero status
   names what is missing. `ready` proves the permission, not that a window is
   visible.
4. Set `plugins.entries.facetime.config.vision.enabled` to `true`, restart the
   Gateway, and run `openclaw gateway call facetime.preflight --json`.
   Expected: a `video-capture` check with `"ok": true`. The Gateway log has no
   `vision is enabled, but` warning.

### Vision, on a call

5. Call the agent with FaceTime video. Keep the FaceTime call window visible on the
   Mac's screen: not minimized, not behind a full-screen app.
6. Hold up an object with large printed text and ask, "What am I holding?"
   Expected: the agent pauses briefly, then names the object and reads the text.
7. Change the object and ask again.
   Expected: the answer changes. It does not repeat the first object.
8. Share your screen in FaceTime, open a window with distinctive text, and ask the
   agent to read the title.
   Expected: it reads the shared screen, not the camera.
9. Minimize the FaceTime window on the Mac and ask what the agent sees.
   Expected: it says it cannot see anything right now. It does not describe the
   earlier view.
10. End the call. Run `pgrep -fl facetime-video-capture`.
    Expected: no process.
11. Search the Gateway log for the call for `data:image` and for `/9j/`, the start
    of a base64 JPEG.
    Expected: no match.

### During a long call

12. Keep a 10-minute call going with both features on. Watch Activity Monitor.
    Expected: `facetime-video-capture` stays near idle between frames; the Gateway
    and OBS do not climb over time. Note the numbers.

## Turning it off

Set both flags to `false`, or remove them, and restart the Gateway. With the flags
off the plugin registers no route, starts no capture helper, and offers the model no
look tool. In OBS, restore the placeholder source.
