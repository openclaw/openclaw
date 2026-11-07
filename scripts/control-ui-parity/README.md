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

`scenarios.ts` owns the route/state catalog. It includes every static
route ID and its redirects, loading/error fixtures, Workboard, Chat content,
collapsed/expanded tool results, SVG/HTML previews, and session diffs,
menus and submenus, a New Group modal, a long model list, selected/disabled
controls, sidebar session menus and hovercards, rich hovercards, and overflowing reader tabs. Twelve profiles cover
desktop/mobile, light/dark, RTL, enlarged text, forced colors, and reduced motion.
This is a coverage matrix, not a full Cartesian product of accessibility settings.

Static preparation fixes dates and decorative randomness, samples JavaScript
animation time, strips SMIL animation instructions from SVG image responses, and
keeps the app service worker unregistered. Routes paint before their independent
sources (config editor, presence, catalogs, lazy styles) arrive, so each shot waits
until no proxied asset is loading and the page has had no DOM, scroll, or focus
change for ten frames and 500 ms. The shared screenshot helper owns layout,
image/font readiness, temporary transition suppression, and caret hiding; it makes
the focused field read-only during capture because forced colors overrides
`caret-color`. The capture profile fixes device scale to 1, color to
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

The complete same-SHA pair at `bfb0400bccfd6ba21b511e4691332d86f8183025`
captured 1,188 shots twice: 1,181 were identical, with 10,817 one-level noise
pixels reported separately. These exact shots are accepted as known
nondeterministic in `config.ts`:

- `route-apps--desktop-large-text`, `route-apps--mobile-light`,
  `route-apps--mobile-dark`, `route-apps--mobile-reduced-motion`: image clipping
  paints differently between runs, even under software rasterization.
- `session-menu--{desktop,mobile}-{light,dark,rtl,large-text,reduced-motion}`:
  the backdrop-filtered session menu rasterizes its text and icons differently in
  long runs, with identical geometry. Forced colors removes the backdrop, and those
  profiles stay identical.

These exact shots remain in captures, galleries, and diff reports, with their
reason and changed-pixel counts. Their pixel differences do not fail the command;
other shots and structural failures keep the normal gates. Inspect them manually
when changing Apps or menus. The boundary tests cover the exception list, an
unlisted Apps shot that still fails, and the one-/two-level RGBA boundary.

Three extended-profile shots still differed in that pair and stay failing until
their owners are fixed: `models-empty--desktop-forced-colors` (a default-model
select is still disabled at capture in one run, visible as `GrayText` only under
forced colors), `route-sessions--desktop-forced-colors` (the table card settles at
a different height), and `route-plugin--desktop-rtl` (the Workboard settles at a
different horizontal scroll offset). The desktop/mobile light/dark selection has
no such residuals.
The real CSS inversion probe detected 1,382,400 changed pixels. No screenshot
baselines are committed.

Migration lanes should capture the base ref and their candidate using the same
frozen harness and browser installation, then run `diff` on the two printed
directories. Review the comparison gallery, including the known exceptions,
alongside each lane's focused behavior tests.

The report contracts run in the standard tooling test project. The capture
matrix is an opt-in suite loaded only by the parity command.

```sh
pnpm test test/scripts/control-ui-parity.test.ts --maxWorkers=1
```
