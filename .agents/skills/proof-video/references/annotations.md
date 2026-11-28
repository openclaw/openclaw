# Measured screenshot and video annotations

Capture the real surface required by the task. A synthetic page can demonstrate
the annotation tools, but cannot prove a product fix. Keep the raw screenshot or
recording and the measured rectangles alongside the annotated output.

For PRs, follow the shared [visual-proof workflow and comparison layout](../../openclaw-pr-maintainer/references/media.md#pr-visual-proof).
The annotation renderer introduced in [#174805](https://github.com/openclaw/openclaw/pull/174805)
works on captured images; it does not choose a scenario or establish product proof.

## Choose marks that explain the fix

The implementing agent selects targets from the PR's visible change, measures
them, and writes factual labels. Use the fewest marks that make the difference
clear, not a box around every changed component:

| Visible change      | Mark                                                    | Example label pair                                  |
| ------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Duplicate content   | Outlines around the repeated/single content             | Account shown twice → Account shown once            |
| Clipping or overlap | Outline or arrow at the affected edge                   | Action clipped → Action fully visible               |
| Alignment           | Guide through corresponding edges or centers            | Renderer-calculated offsets from the same reference |
| Spacing             | Bracket between measured edges                          | Renderer-calculated gap before and after            |
| Moved control       | Arrow to its old/new location, retaining surrounding UI | Action in overflow → Action beside item             |

Label observations, not verdicts such as “Bad” and “Fixed.” Do not invent numbers
or imply that a still proves timing or backend behavior. Place labels in clear
space and outline strokes outside the text they explain. Keep exact measured
bounds for alignment/spacing even if an outline needs visual padding.

## Callout appearance and color

Use a filled, softly rounded card with a prominent sans-serif title, quieter
secondary detail, and an optional compact pill for a meaningful measured delta.
The shared renderer supplies this layout, fine outlines, and thin pointers; do
not build a separate per-PR card renderer or recolor its generated markup.

The annotating agent chooses `color` (a `#RRGGBB` accent) after inspecting the
actual screenshot, its theme, and the area behind the annotation. The renderer
derives the card, border, text, and pill colors from that accent. Lilac is not a
fixed default for every image. Keep a matched before/after pair on the same
palette when it remains readable in both. Check the resulting text, pointer,
and target outline at the intended display size; color choice is not an
automatic contrast guarantee. When omitted, the existing mark-specific accent
is used.

For arrows and outlines, `text` is the title. Add `detail` only when it helps
explain the observation, and `badge` only for a verified delta or similarly
useful short value. Alignment and spacing retain their renderer-calculated
titles; secondary fields never replace those measurements. Do not make up a
number just to fill the pill.

```json
{
  "kind": "arrow",
  "from": { "x": 470, "y": 532 },
  "to": { "x": 408, "y": 532 },
  "labelAt": { "x": 480, "y": 490 },
  "text": "Wider account menu",
  "detail": "336 CSS px wide",
  "badge": "+32",
  "color": "#8570ad"
}
```

This is an annotation example, not a measurement of your screenshot. Use the
actual saved bounds and comparison values. Cards grow with their content; keep
the title/detail short and place the whole card in clear space.

## Geometry

All positions use one capture coordinate system with a top-left origin. For web
captures use viewport CSS pixels; `scale` is image pixels per CSS pixel, not zoom.
Use the settled bounds returned by `takeControlUiScreenshotFrame`, or measure
with Playwright `locator.boundingBox()` when capturing outside that helper.
Reject missing or offscreen targets. The first rectangle is the alignment
reference. Use `labelAt` to place a label in clear space.

For native outlines/arrows, use the verified logical capture dimensions as
`viewport` and image pixels per logical unit as `scale`. This keeps labels
readable on high-density screenshots without resizing the source image. Map
accessibility/test bounds into that coordinate system, accounting for window
origin and orientation; native points or Android density-independent units are
not image pixels. If no bounds are reported, locate the target in the inspected
screenshot, but do not present estimates as precise measurements.

The renderer's numeric alignment/spacing labels say `px`. For native physical-
pixel measurements, use image-pixel bounds, PNG dimensions as `viewport`, and
`scale: 1`; use a matched close crop if labels would otherwise be unreadable.
Do not present native point/density-independent measurements as physical pixels.
Use PNG captures, or convert a captured JPEG to PNG without resizing it; retain
the original alongside the PR artifacts.

For a crop, translate targets and labels by the crop origin in the same units.
Web frame crops expose `pixelBounds`: subtract their pixel origin from
pixel-converted target coordinates and annotate that cropped PNG with `scale: 1`.
Do not take another screenshot to annotate or modify the app to draw the marks.

| Kind        | Fields                        | Meaning                                                                                                                                                                                                        |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arrow`     | `from`, `to`, optional `text` | Pointer between `{x,y}` positions; stop just short of the evidence.                                                                                                                                            |
| `outline`   | `rect`, optional `text`       | Unfilled boundary around `{x,y,width,height}`.                                                                                                                                                                 |
| `alignment` | `axis`, `edge`, `rects`       | `axis: "x"` compares horizontal coordinates with a vertical guide; `"y"` compares vertical coordinates. `edge` is `start`, `center`, or `end`. Label reports maximum absolute offset from the first rectangle. |
| `spacing`   | `axis`, `from`, `to`, `at`    | Rectangles ordered left-to-right (`x`) or top-to-bottom (`y`). Measures the gap between edges, or the intersecting interval when they overlap. `at` locates the bracket on the other axis.                     |

Every kind accepts optional `labelAt: {x,y}`, `color`, `detail` (1–80 characters),
and `badge` (1–16 characters). Arrow/outline secondary fields require `text`.
Each text row stays on one line and must fit; shorten text instead of shrinking
it. Bounds and the complete card must fit the capture viewport.

## Screenshot

Save a frame JSON with this shape, using the actual measured rectangles:

```json
{
  "viewport": { "width": 1280, "height": 800 },
  "scale": 2,
  "annotations": [
    {
      "kind": "alignment",
      "axis": "x",
      "edge": "start",
      "rects": [
        { "x": 240, "y": 200, "width": 400, "height": 48 },
        { "x": 264, "y": 320, "width": 400, "height": 48 }
      ],
      "labelAt": { "x": 700, "y": 300 }
    }
  ]
}
```

```sh
node --import tsx scripts/annotate-proof-image.mts \
  --input .artifacts/proof/raw.png \
  --annotations .artifacts/proof/frame.json \
  --out .artifacts/proof/annotated.png
```

The input dimensions must equal viewport × scale. Output files are never
overwritten. Screenshot and overlay rasterization use fresh browser contexts;
keep screenshot capture separate from active video recording.

## Video

```ts
const reference = await page.locator(".reference").boundingBox();
const target = await page.locator(".target").boundingBox();
if (!reference || !target) throw new Error("Proof targets must be visible");
recording.annotate([{ kind: "alignment", axis: "x", edge: "start", rects: [reference, target] }]);
await recording.zoom(target);
// Hold the asserted result long enough to read, then clear before layout changes.
recording.clearAnnotations();
```

`annotate()` replaces the current annotation group; `clearAnnotations()` ends it.
`finish()` closes active cues and rasterizes overlays. Render with the existing
`render-proof-video.mts` command. Speed changes remap annotation windows with the
other cues. Marks share the captured image's camera transform through zoom.

Native recordings use the same sidecar with a cue like:

```json
{
  "kind": "annotation",
  "start": 2,
  "end": 6,
  "image": "annotations/0.png",
  "annotations": [{ "kind": "outline", "rect": { "x": 240, "y": 200, "width": 400, "height": 48 } }]
}
```

Times use the raw-video clock. `--rasterize` creates missing annotation PNGs.
Use a new evidence directory after changing geometry, to avoid reusing old PNGs.

## Inspection

Compare raw and annotated stills. Check that arrowheads indicate the intended
target, guides use the same reference in both states, measured labels agree with
saved bounds, and marks do not cover the changed pixels. Read at full size and
the expected PR display size. For video, inspect the full timeline plus frames
at mark changes, zoom holds, speed boundaries, and the result. Reposition labels
or shorten cues when zoom crops them or the underlying layout moves.

Design references: [WordPress doc-screenshots](https://github.com/WordPress/wordpress-playground/tree/trunk/.agents/skills/doc-screenshots)
for measured targets and inspection; [Big Arrow](https://github.com/franzenzenhofer/big-arrow-on-the-screen)
for clear labeled pointers. This renderer is implemented locally; these tools
are not runtime dependencies.
