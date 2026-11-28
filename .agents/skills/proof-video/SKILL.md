---
name: proof-video
description: Capture and annotate PR screenshots and videos with measured arrows, outlines, alignment guides, spacing brackets, captions, zoom, and speed cues.
---

# Proof video

For **PR screenshots**, start with the shared [visual-proof workflow](../openclaw-pr-maintainer/references/media.md#pr-visual-proof),
then use [annotations](references/annotations.md#screenshot). Capture through the
existing platform workflow; no recorder, video, or ffmpeg setup is needed for
stills. These annotations are PR artifacts, not store/release screenshots.

Use the recording sections below for captioned Control UI and native video.
Captions are burned into an MP4; they are visual narration, not synthesized audio.
Keep the raw video as evidence, attach the polished MP4, and never commit media or
`.artifacts/` output. Inspect the entire capture for unrelated or private content
before publishing under the PR's existing authorization.

For added or changed errors, empty states, and loading states, follow the
[state capture gate](../openclaw-pr-maintainer/references/media.md#error-empty-and-loading-states).
Capture every changed state, including real-channel link forms when applicable.
Use stills when they prove the state. Record transitions when motion is the claim.
Copy-only ellipsis removal does not authorize adding loading animation.

## Point out the claim

For target selection, native/web geometry, and inspection, read
[annotations](references/annotations.md).
Both paths use the same SVG geometry renderer. Annotations are composited before
zoom, while narration stays fixed in the viewport. Re-measure and replace marks
after scrolling or layout changes; a cue describes a stationary capture, not a
live element tracker. Clear marks during movement when they would become stale.

## Standalone recording

For captioned Control UI recording, first read the shared
[rendering and capture limits](references/rendering.md) in full, then the
[standalone recording procedure](references/recording.md) in full. The latter
contains the runnable template and helper API.

## Render

Before any video capture or render, read [rendering and capture limits](references/rendering.md)
in full. They apply to both Control UI and native recordings.

## Cue sidecar v1 and native captures

For native recordings, read [native captures and cue sidecars](references/native-captures.md)
and the shared [rendering and capture limits](references/rendering.md) in full
before capture or annotation. Preserve the raw native recording.

## Verified capture mode and limitations

The [capture limits](references/rendering.md#verified-capture-mode-and-limitations)
are part of the required shared rendering read before every video capture or
render. Inspect the finalized recording before attaching it.
