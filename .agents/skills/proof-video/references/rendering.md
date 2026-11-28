## Render

Use the exact directory printed by the recording:

```bash
node --import tsx scripts/render-proof-video.mts --cues .artifacts/proof-video/<capture>/cues.json
```

The renderer prints the output path and duration. Optional `--input <video>`
overrides the raw input and `--out <file.mp4>` chooses the output. Existing output
files are refused, preserving raw evidence and earlier renders. It uses trusted
system `ffmpeg` and `ffprobe`, never Playwright's bundled encoder. Install a full
system build with `brew install ffmpeg` or `apt install ffmpeg`.

Speed segments split the raw timeline with trim/setpts/concat, then normalize it
to the input frame rate. Caption windows and zoom transitions are remapped to
output time. Zoom uses `zoompan` with `d=1` and matching input FPS; a 100-frame,
4-second, 25-FPS synthetic capture retained exactly 100 frames and 4 seconds,
with a visibly and numerically different zoom hold. Dynamic crop width/height
expressions do not animate: ffmpeg evaluates them only at initialization.
Output is viewport-sized H.264 MP4, yuv420p, CRF 23, with faststart and no audio.

## Verified capture mode and limitations

On macOS with Playwright 1.62.1 and Chromium 151.0.7922.34, context
`deviceScaleFactor: 2` produced a 2560×1600 WebM containing only 1280×800 page
content plus gray padding. Launching with `--force-device-scale-factor=2` and
leaving context emulation at 1 recorded true 2× content: a 100-CSS-pixel marker
measured 200×200 at raw coordinates (2360, 1400). The helper defaults to
`deviceScaleFactor: 2` for recording size and sidecar scale; the launch flag in
the template is required. This parameter does not enable context emulation.
For verified 1× capture, launch without the flag and pass `deviceScaleFactor: 1`.
The renderer uses Lanczos pre-upscaling for 1× sources, but cannot restore lost
detail: a 2× zoom on those recordings is softer.

The cue clock starts at context creation using `performance.now()`. Playwright's
video clock can differ by roughly 100 ms, and startup/load can increase the skew;
inspect action/caption alignment in the finalized recording. Avoid clipped,
locator, or full-page screenshots during recording: Chromium can corrupt the
screencast surface. Caption rasterization happens only after recording closes,
in a fresh context. See the Control UI E2E skill's screenshot guidance.

GitHub's player ignores subtitle tracks, so captions must be burned in. The
renderer requires crop, scale, overlay, setpts, trim, concat, fps, and zoompan in
the system ffmpeg build. It does not use `subtitles=` or `drawtext=`. Variable
frame-rate native captures need conversion to a separate constant-frame-rate
working copy first; retain the original. Frame-rate quantization can shift
speed-segment boundaries by about one output frame. Check output duration and
extract caption, zoom-hold, and sped-segment frames before attaching the MP4.
