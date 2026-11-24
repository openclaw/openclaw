# Blobster Design Guide

`openclaw agents render-blobster <design> --out <path>` compiles a versioned JSON design into OpenClaw's canonical 256×256 static Blobster SVG (`viewBox="-12 -18 144 144"`) or rasterizes it to a transparent 256×256 PNG. The renderer supplies the fixed lobster anatomy, MIT license metadata, body clip path, shell highlight, and eyes automatically.

## Fixed Lobster Geometry & Canvas

- **Canvas (`viewBox`):** `x = -12..132`, `y = -18..126` (`width = 144`, `height = 144`, rendered at `256×256`). Keep every coordinate well inside this box so props and hats never clip at the frame edge.
- **Antennae (drawn behind everything in `palette.shell`):** `M46 14 Q38 4 31 7` and `M74 14 Q82 4 89 7` (`y ≈ 4..14`). Headwear or sprouts near the crown (`x ≈ 46..74`, `y ≈ -6..14`) sit cleanly between or slightly over the antennae.
- **Body silhouette (`palette.shell`):** `x = 16..104`, `y = 8..104`, centered at `x = 60`, with little feet at `x = 44..54` and `x = 66..76` down to `y = 104`:
  `M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z`
- **Left claw (`palette.claw`, viewer's left):** `x = 0..28`, `y = 37..67`, grip center around `(18, 48)`.
- **Right claw (`palette.claw`, viewer's right):** `x = 92..120`, `y = 37..67`, grip center around `(102, 48)`.
- **Forehead highlight:** subtle white sheen at `cx = 48, cy = 28, rx = 20, ry = 11`.
- **Eyes (always drawn last on top of all layers):** dark pupils (`r = 5.5`) at `(45, 32)` and `(75, 32)` with `palette.glint` highlights (`r = 2.2`) at `(46.5, 30.5)` and `(76.5, 30.5)`. Never redraw eyes or cover `y = 24..40` across `x = 36..84` unless designing thin eyewear frames around `(45, 32)` and `(75, 32)` in `accessory`.

## Paint Order & Layer Rules

All five keys in `layers` are required strings (use `""` for unused layers):

1. `back` — **Must be `""`.** The renderer validates `back` and intentionally omits backgrounds so every Blobster keeps a clean silhouette on light and dark surfaces.
2. `left_prop` — Drawn **behind** the viewer-left claw (`x = 0..28, y = 37..67`). Place the handle or grip near `(14..22, 44..56)` and extend the visible head of the prop above (`y = 12..38`) or outward (`x = -8..10`) so the claw appears to hold it.
3. `right_prop` — Drawn **behind** the viewer-right claw (`x = 92..120, y = 37..67`). Place the handle or grip near `(98..108, 44..56)` and extend the prop head above (`y = 12..38`) or outward (`x = 110..128`).
4. `shell_overlay` — Drawn over the body and **clipped to `blobster-body-clip`** (`BODY`). Ideal for jackets, aprons, collars, sashes, badges, and chest emblems across `y = 44..98` (below the eyes). Note: shapes extending above `y = 8` or outside `x = 16..104` will be clipped here—put hats, headsets, or crown sprouts that extend outside the body silhouette in `accessory`.
5. `accessory` — Drawn **unclipped** above `shell_overlay` and the forehead sheen, but **under** the eyes. Use sparingly for small hats, visors, antennas, glasses frames, scarf tails, or lapel pins that remain compact enough to preserve the rounded body and claws.

## JSON Schema

```json
{
  "version": 1,
  "id": "radar-watch",
  "name": "Radar Watch",
  "description": "A cobalt-blue Blobster in a high-visibility dispatch vest holding a signal dish.",
  "palette": {
    "shell": "#3b6ea8",
    "claw": "#285185",
    "glint": "#d9f2ff"
  },
  "layers": {
    "back": "",
    "left_prop": "",
    "right_prop": "<path d=\"M104 54 L110 30\" fill=\"none\" stroke=\"#526071\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"112\" cy=\"24\" r=\"9\" fill=\"#e2ecf5\" stroke=\"#526071\" stroke-width=\"2\"/>",
    "shell_overlay": "<path d=\"M20 52 Q60 62 100 52 L100 96 L20 96 Z\" fill=\"#1d2b3a\"/><path d=\"M34 55 L44 96 M86 55 L76 96\" fill=\"none\" stroke=\"#f5b742\" stroke-width=\"4\"/>",
    "accessory": ""
  }
}
```

### Field & Sanitizer Constraints

- Top-level object is strict (`additionalProperties: false`): only `version`, `id`, `name`, `description`, `palette`, and `layers` are accepted.
- `version`: literal `1`.
- `id`: `1..80` chars matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- `name`: `1..120` chars; `description`: `1..1000` chars (one concise sentence).
- `palette.shell`, `palette.claw`, `palette.glint`: 6-digit hex colors (`#RRGGBB`). Contrast `shell_overlay` strongly against `palette.shell` so clothing reads at `24×24` px.
- **Allowed SVG elements (max 128 elements, max nesting depth 12 per layer):** `g`, `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`. No `<text>`, `<defs>`, `<linearGradient>`, `<use>`, `<image>`, `<style>`, `<script>`, XML declarations, or HTML comments.
- **Allowed attributes:**
  - Geometry: `x`, `y`, `x1`, `x2`, `y1`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `width`, `height`, `d`, `points`
  - Paint & stroke: `fill`, `stroke` (`#RRGGBB` or `"none"` only—no `rgb()`, named colors, or `url(...)`), `opacity`, `fill-opacity`, `stroke-opacity` (`0..1`), `stroke-width`, `stroke-miterlimit`, `stroke-dashoffset`, `stroke-dasharray`, `stroke-linecap` (`butt` | `round` | `square`), `stroke-linejoin` (`miter` | `round` | `bevel`), `fill-rule` (`nonzero` | `evenodd`), `clip-rule` (`nonzero` | `evenodd`)
  - Grouping: `class` (`[A-Za-z0-9_ -]+`), `transform` (`translate(...)`, `scale(...)`, `rotate(...)` only)
  - All numeric operands must be finite with `|n| <= 2000`.

## Reference Layer Fragments

Adapted from OpenClaw's MIT reference fixtures:

- **Apron & pocket (`shell_overlay`):**
  ```xml
  <path d="M35 49 L46 49 L47 60 L73 60 L74 49 L85 49 L90 86 Q60 103 30 86 Z" fill="#f1e4c4"/>
  <path d="M49 69 H71 V83 Q60 88 49 83 Z" fill="#638d69"/>
  ```
- **Claw-held microphone (`right_prop`):**
  ```xml
  <path d="M106 32 L112 34 L106 56 Q105 58 103 57 Q101 56 102 54 Z" fill="#343747"/>
  <path d="M103 27 A7 7 0 1 1 117 27 A7 7 0 1 1 103 27 Z" fill="#666a80"/>
  <path d="M106 23 L114 25 M105 27 L113 29" fill="none" stroke="#e7e7f0" stroke-width="1.5" stroke-linecap="round"/>
  ```
