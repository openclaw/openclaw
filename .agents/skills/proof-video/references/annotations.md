# Measured screenshot and video annotations

Capture the real surface required by the task. A synthetic page can demonstrate
the annotation tools, but cannot prove a product fix. Keep the raw screenshot or
recording and the measured rectangles alongside the annotated output.

## Geometry

All positions use viewport CSS pixels, top-left origin. `scale` is raw pixels per
CSS pixel, not zoom. The first rectangle is the alignment reference. Measure
each target in the settled state with Playwright `locator.boundingBox()`; reject
missing or offscreen targets. Use `labelAt` to place a label in clear space.

| Kind        | Fields                        | Meaning                                                                                                                                                                                                        |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arrow`     | `from`, `to`, optional `text` | Pointer between `{x,y}` positions; stop just short of the evidence.                                                                                                                                            |
| `outline`   | `rect`, optional `text`       | Unfilled boundary around `{x,y,width,height}`.                                                                                                                                                                 |
| `alignment` | `axis`, `edge`, `rects`       | `axis: "x"` compares horizontal coordinates with a vertical guide; `"y"` compares vertical coordinates. `edge` is `start`, `center`, or `end`. Label reports maximum absolute offset from the first rectangle. |
| `spacing`   | `axis`, `from`, `to`, `at`    | Rectangles ordered left-to-right (`x`) or top-to-bottom (`y`). Measures the gap between edges, or the intersecting interval when they overlap. `at` locates the bracket on the other axis.                     |

Every kind accepts optional `labelAt: {x,y}`. Labels are single-line and must fit;
shorten text instead of shrinking it. Bounds must fit the capture viewport.

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
