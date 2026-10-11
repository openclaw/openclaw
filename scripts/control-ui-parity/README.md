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
expected shots have no unaccepted differences. Missing, incomplete, incompatible,
or resized captures fail, including the known nondeterministic shots below.

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
one level. Any channel delta of two or more fails outside the explicit exceptions
below. This accommodates measured
one-level rounding around antialiased shadows after rendering has been pinned;
it is not a percentage or count allowance. JSON, HTML, and console reports count
these pixels separately as **raster noise (≤1 level): N px**. Diff images mark
failing pixels pink and accepted raster noise blue.

The complete same-SHA pair at `10d3967be440ea06a7e2a8c985edf9dc7664e23b`
captured 924 shots twice: 921 had no failing differences, with 52 one-level noise
pixels reported separately. The three remaining Apps image-clipping cases are
accepted as known nondeterministic in `config.ts`:

- `route-apps--mobile-light`
- `route-apps--mobile-dark`
- `route-apps--mobile-reduced-motion`

Image clipping paints differently between runs, even under software rasterization.
These exact shots remain in captures, galleries, and diff reports, with their
reason and changed-pixel counts. Their pixel differences do not fail the command;
other shots and structural failures keep the normal gates. Inspect these three
shots manually when changing Apps. The boundary tests cover the exception list,
an unlisted Apps shot that still fails, and the one-/two-level RGBA boundary.
The real CSS inversion probe detected 1,382,400 changed pixels. No screenshot
baselines are committed.

Migration lanes should capture the base ref and their candidate using the same
frozen harness and browser installation, then run `diff` on the two printed
directories. Review the comparison gallery, including the three known exceptions,
alongside each lane's focused behavior tests.

The report contracts run in the standard tooling test project. The capture
matrix is an opt-in suite loaded only by the parity command.

```sh
pnpm test test/scripts/control-ui-parity.test.ts --maxWorkers=1
```
