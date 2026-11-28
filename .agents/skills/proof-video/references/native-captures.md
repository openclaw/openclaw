## Cue sidecar v1 and native captures

Save a hand-written `cues.json` beside an untouched native `.mov` or `.webm`.
Use `scale` for actual raw pixels per viewport CSS pixel, not display metadata.
Input dimensions must equal viewport × scale and frame rate must be constant.
All times below are seconds in the RAW video. Caption image paths are relative
to the sidecar directory. Zoom cues cannot overlap other zoom cues; speed cues
cannot overlap other speed cues. Adjacent cues are allowed.

```json
{
  "version": 1,
  "video": "capture.mov",
  "viewport": { "width": 1280, "height": 800 },
  "scale": 2,
  "captionHeight": 120,
  "cues": [
    {
      "kind": "caption",
      "start": 1,
      "end": 4,
      "text": "Inspect the session controls.",
      "image": "captions/0.png"
    },
    {
      "kind": "zoom",
      "start": 1,
      "end": 4,
      "rect": { "x": 20, "y": 150, "width": 280, "height": 80 },
      "factor": 2,
      "ease": 0.5
    },
    { "kind": "speed", "start": 5, "end": 9, "factor": 4 }
  ]
}
```

```bash
node --import tsx scripts/render-proof-video.mts --cues <dir>/cues.json --rasterize
```

`--rasterize` creates missing caption and annotation PNGs with fresh Playwright Chromium pages.
The exported `rasterizeProofOverlays(browser, cues, dir)` also supports programmatic
native-capture workflows. Neither path needs libass or drawtext: Chromium
rasterizes text and geometry. ffmpeg overlays annotations before zoom and captions
after zoom.
