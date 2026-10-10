# Control UI visual parity

Generate screenshots through the existing mock-Gateway E2E build, then compare
capture directories. Generated baselines and reports are artifacts; do not commit
them.

```sh
pnpm ui:parity capture --output /absolute/path/to/artifacts
pnpm ui:parity diff /absolute/path/to/before /absolute/path/to/after --output /absolute/path/to/reports
```

Each capture prints its fresh directory. It contains PNGs, `manifest.json`, and a
browser-openable `index.html` with per-example feedback fields and **Copy feedback**.
The manifest records the source HEAD, dirty paths, browser, platform, fixture
fingerprint, exact expected shot set, and each PNG's hash and dimensions. The diff
writes an HTML comparison, JSON report, and changed-pixel PNGs. Exit 0 means all
expected shots have no failing pixel differences; missing, incomplete, incompatible, or changed
captures fail.

Use the same frozen harness, browser version, platform, fonts, and profile/scene
selection at each source ref. A screenshot baseline is only evidence for the
source and fixtures recorded in its manifest. Dirty source is reported, not
silently described as a clean ref.

For a focused iteration:

```sh
pnpm ui:parity capture --scene '^route-chat$' --profile '^desktop-light$'
```

For a CSS sensitivity check, repeat that selection with a file containing a
visible rule, such as `body { filter: invert(1); }`:

```sh
pnpm ui:parity capture --scene '^route-chat$' --profile '^desktop-light$' --css /absolute/path/to/probe.css
```

`--css` changes only the captured browser and records the stylesheet hash. It does
not edit source. Capture always uses the shared settled-layout, visible-image,
font, and static-animation preparation. Dates, locale, timezone, device scale,
and fixture randomness are fixed. No real Gateway or credentials are used.

## Catalog and qualification

`scenarios.ts` owns 77 route/state entries. The catalog includes every static
route ID and its redirects, loading/error fixtures, Workboard, Chat content,
menus and submenus, a New Group modal, a long model list, selected/disabled
controls, rich hovercards, and overflowing reader tabs. Twelve profiles cover
desktop/mobile, light/dark, RTL, enlarged text, forced colors, and reduced motion.
This is a coverage matrix, not a full Cartesian product of accessibility settings.

Static preparation fixes dates and decorative randomness, samples JavaScript
animation time, and strips SMIL animation instructions from SVG image responses.
The shared screenshot helper owns layout, image/font readiness, and temporary
transition suppression. The capture profile fixes device scale to 1, color to
sRGB, font hinting to none, and waits an extra animation frame after settlement.
The shared E2E suite disables GPU/partial rasterization; the profile also requests
Chromium's fresh-surface screenshot path.

`MAX_RASTER_NOISE_CHANNEL_DELTA = 1` is the comparison policy: a changed pixel
passes only when its maximum absolute delta across all RGBA channels is at most
one level. Any channel delta of two or more fails. This accommodates measured
one-level rounding around antialiased shadows after rendering has been pinned;
it is not a percentage or count allowance. JSON, HTML, and console reports count
these pixels separately as **raster noise (≤1 level): N px**. Diff images mark
failing pixels pink and accepted raster noise blue.

The full 924-shot pair must be requalified with this policy before the harness
serves as the migration gate. The boundary tests prove one-level shifts pass and
two-level shifts fail in every RGBA channel; the real CSS sensitivity capture
must still fail. No screenshot baselines are committed.

Run the opt-in report tests through the repository Vitest wrapper:

```sh
node scripts/run-vitest.mjs run --config scripts/control-ui-parity/report.vitest.config.ts --configLoader runner scripts/control-ui-parity/report.test.ts --maxWorkers=1
```
