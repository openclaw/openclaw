# Reproducible build / deploy / rollback pipeline

`scripts/deploy-pipeline.mjs` turns one clean OpenClaw build into an immutable,
versioned, atomically activatable release. Every change ships through it so a
deploy is always **one whole consistent `dist`**, never an in-place overlay of
loose files.

Run it directly or via the package script:

```bash
node scripts/deploy-pipeline.mjs <command> [options]
pnpm deploy:pipeline <command> [options]
```

## Why a pipeline

A prior practice of copying freshly compiled files on top of an existing `dist`
("dist overlays") produced builds that mixed artifacts from two different
commits and broke at runtime. The pipeline removes that failure mode:

- The build runs to completion or the dist is rejected — no partial dist.
- Each release is copied **whole** into its own immutable directory. Releases
  are never re-staged on top of; a new build always gets a new release id.
- Activation is a single symlink swap, so a release is either fully live or not
  live at all. Rollback is the same swap in reverse.
- Every release is a complete runnable package root, verified as such before it
  goes live — never a bare `dist/` that boots but cannot start a channel.

## Layout

The pipeline owns a **deploy root** — a directory outside the source checkout.
Pass it with `--deploy-root <path>` or the `OPENCLAW_DEPLOY_ROOT` env var.

```
<deploy-root>/
  releases/
    <release-id>/      a complete, runnable OpenClaw package root:
      dist/            the build output
      package.json     + openclaw.mjs, docs/, skills/, … (package.json "files")
      release.json     manifest: id, version, commit, stagedAt, distHash
  node_modules/        shared once; releases resolve dependencies through it
  current -> releases/<release-id>     atomically swapped symlink
  activations.jsonl    append-only audit log of every activate/rollback
```

A release id is `<version>-<commit12>-<utc-timestamp>`, e.g.
`2026.5.19-57ec361682e0-2026-05-18t12-00-00-000z`. The runtime/service should
run `<deploy-root>/current/dist/index.js` and follow the symlink on each start.

A release is a **complete package root**, not a bare `dist/`. OpenClaw resolves
bundled channel plugins by walking up from `dist/` for an `openclaw`
`package.json`, and reads runtime assets (e.g. `docs/reference/templates/`) from
the package root — a dist-only release boots but cannot start a channel. `stage`
therefore copies `dist/` plus every top-level entry that `package.json` "files"
declares. `node_modules` is large and version-stable, so it is shared once at
the deploy root rather than copied per release; Node resolves it by walking up
from a release's `dist/`.

## Commands

| Command         | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `verify [dir]`  | Check that a dist (default `./dist`) is whole and consistent.       |
| `build`         | Run `pnpm build` + `pnpm ui:build`, then verify the resulting dist. |
| `stage`         | Verify `./dist` and copy it as a new immutable release.             |
| `activate [id]` | Atomically point `current` at a release (default: newest staged).   |
| `rollback`      | Atomically point `current` back at the previously active release.   |
| `deploy`        | `build` → `stage` → `activate`, in one step.                        |
| `list`          | List staged releases and mark the active one.                       |
| `prune`         | Remove old releases, keeping `--keep` most recent.                  |

### Options

| Option                  | Meaning                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`, `-n`       | Print every action; change nothing on disk; run no build. A dry-run `deploy` previews every step even with no `./dist` present.            |
| `--deploy-root <dir>`   | Deploy root location (or set `OPENCLAW_DEPLOY_ROOT`).                                                                                      |
| `--dist <dir>`          | Dist directory to verify/stage (default `./dist`).                                                                                         |
| `--release`             | `verify`: check a staged release _package root_ (the full dist-only guard) instead of a bare dist; default target `<deploy-root>/current`. |
| `--clean`               | `build`/`deploy`: run `pnpm install --frozen-lockfile` first.                                                                              |
| `--expect-commit <sha>` | Fail verification unless the dist was built from `<sha>`.                                                                                  |
| `--keep <n>`            | `prune`: number of recent releases to keep (default 5).                                                                                    |
| `--id <id>`             | `stage`: use an explicit release id instead of generating one.                                                                             |
| `--health-cmd <cmd>`    | `activate`/`deploy`: shell command run after activation; on failure `current` rolls back.                                                  |
| `--health-timeout <s>`  | `--health-cmd` timeout in seconds (default 120).                                                                                           |

## Consistency checks (the anti-overlay guard)

`verify` — run before every `stage` and before every `activate` — refuses a
dist that is not a single clean build:

1. **Completeness.** `index.js`, `.buildstamp`, `.runtime-postbuildstamp`,
   `build-info.json`, a non-empty `plugin-sdk/`, `plugins/runtime/index.js`,
   and the Control UI bundle (`control-ui/index.html` plus a non-empty
   `control-ui/assets/`) must all be present. These come from distinct build
   phases, so a missing one means the build was interrupted. The Control UI is
   built by a separate `pnpm ui:build` (vite) phase — `pnpm build` alone does
   not emit it — so `build`/`deploy` run `ui:build` after `pnpm build`. A dist
   without it boots but the gateway logs `Missing Control UI assets at
<release>/dist/control-ui/index.html` and serves no web UI.
2. **Single-commit provenance.** `build-info.json`, `.buildstamp`, and
   `.runtime-postbuildstamp` each record the git commit they were built from.
   A genuine build writes the same commit to all three. **Divergent commits are
   the signature of a dist overlay** — files from one build copied on top of
   another — and verification fails.
3. **Version match.** `build-info.json`'s version must equal the repo
   `package.json` version.
4. **Optional pinning.** `--expect-commit <sha>` fails the dist unless it was
   built from exactly that commit.

At `stage` time the pipeline records a SHA-256 `distHash` of the whole tree in
`release.json`. `activate` recomputes it and refuses the release if it differs —
catching any modification made to an artifact after it was staged.

### Release-package check

Before every `activate`, the staged release is additionally checked as a
_runnable package_ — not just a dist:

- the dist passes every check above;
- `package.json` is present and named `openclaw`;
- every top-level entry `package.json` "files" declares is present
  (`dist/`, `openclaw.mjs`, `docs/`, `skills/`, …);
- a `node_modules` is reachable by walking up from the release `dist/`.

A dist-only release boots but cannot start any channel ("Unable to resolve
plugin runtime module") or dispatch a message ("Missing workspace template").
This check refuses such a release before it is activated.

The same check is available on demand as `verify --release <release-dir>`. It
is read-only — it never moves `current` or restarts anything — so a staged
release can be smoke-checked before a cutover is attempted. With no directory
argument it checks `<deploy-root>/current`.

```bash
# Smoke-check a staged release as a runnable package, touching nothing live:
node scripts/deploy-pipeline.mjs verify --release \
  /srv/openclaw/releases/2026.5.12-f066dd2f31c0-2026-05-19t00-00-00-000z
```

## Atomic activation and rollback

`activate` writes a new symlink to a temporary name, then `rename()`s it over
`current`. On POSIX this replaces the symlink atomically: readers always see a
complete release. Every activation appends an entry to `activations.jsonl` with
the release that was active before it, which is what `rollback` reads to find
its target.

> **Windows.** Directory symlinks are created as junctions, and the swap removes
> the old `current` before renaming the new one — a sub-millisecond window where
> `current` is briefly absent. POSIX hosts have no such window.

## Wiring a service to the pipeline

The pipeline stages and activates releases, but it does **not** reconfigure the
service manager. Activating a release moves the `current` symlink; a running
service keeps executing whatever path it was started with until it is pointed
at `current` and restarted.

To put a managed service under the pipeline, do a one-time cutover:

1. Pick a stable deploy root outside the source checkout and stage at least one
   release into it (`OPENCLAW_DEPLOY_ROOT` or `--deploy-root`).
2. Change the service start command to run `<deploy-root>/current/dist/index.js`
   — the symlink, never a release id — so each start follows whatever
   `activate`/`rollback` last pointed `current` at.
3. Restart the service once to adopt the new path. This restart is the cutover
   and causes a brief interruption; schedule it accordingly.

After cutover, `activate` and `rollback` change which release the next service
start runs; they do not restart the service themselves. Pair an activation with
a service restart (or reload) to make it take effect.

### The first cutover

Moving a _live_ service onto the pipeline is higher-risk than the
`activate`/`rollback` swaps that follow it: there is no prior pipeline release
to fall back to, and a delivery problem can be mistaken for an application bug.
Reduce that risk:

- **Pin to a known-good build.** Stage and cut over a stock, already-proven
  build, and do not combine the first cutover with an application upgrade — one
  variable at a time. Build that commit and `stage --expect-commit <sha>` so a
  wrong dist is refused. Note that `verify`/`stage` also cross-check the dist's
  `build-info.json` version against the repo `package.json`, so run the pipeline
  from the same checkout you built — an older pinned build verified against a
  newer repo version is rejected.
- **Verify the release as a package, not a dist.** Run `verify --release` on
  the staged release before going near the live service.
- **Run it on an alternate port first.** Start `<release-dir>/dist/index.js`
  with a non-production gateway port and an isolated config, confirm it boots
  and that channels start (no "Unable to resolve plugin runtime module"), then
  stop it. Nothing live has changed yet.
- **Back up the service config before repointing.** Copy the existing service
  unit / override file before editing it. For this first cutover, _rollback is
  restoring that backup_ and restarting — `deploy-pipeline rollback` only has a
  target from the second pipeline activation onward.

### Post-activation health check

`verify` and the release-package check refuse a structurally broken release
_before_ activation. To also catch a release that is structurally fine but
fails to _run_, pass `--health-cmd`: after the symlink swap the pipeline runs
that command from the deploy root, and if it exits non-zero — or times out
(`--health-timeout`, default 120 s) — `current` is rolled back to the previous
release. For a systemd service, a useful check restarts the unit and probes it:

```bash
node scripts/deploy-pipeline.mjs deploy --deploy-root /srv/openclaw \
  --health-cmd "systemctl --user restart openclaw-gateway && sleep 8 && systemctl --user is-active openclaw-gateway"
```

## Verifying a release with doctor

`openclaw doctor` probes bundled channels and providers by walking up from its
own entrypoint for the `openclaw` package root. Run it **from the active
release** so it inspects the same package root the live service runs:

```bash
node <deploy-root>/current/dist/index.js doctor
```

A `doctor` invoked from a different `openclaw` install (for example a global
npm package still on `PATH`) probes _that_ install, not the release — its
bundled-channel checks can then resolve a different root than the running
gateway and report load errors for channels (e.g. telegram) that the gateway
in fact starts cleanly. If the gateway logs show a channel started but `doctor`
reports it failed to load, confirm `doctor` was run from `current/dist/index.js`
before treating the message as a real fault.

A restricted `plugins.allow` together with `plugins.bundledDiscovery: "compat"`
also draws a `doctor` note, and is **not** a pipeline fault: `compat` is the
supported mode for migrated configs and force-loads bundled provider plugins
regardless of the allowlist. Switching to `"allowlist"` would gate every
bundled provider behind `plugins.allow`, so keep `compat` unless every required
bundled provider id is listed in `allow`.

## Typical use

```bash
# Local dry run — see exactly what a deploy would do, touch nothing:
node scripts/deploy-pipeline.mjs deploy --dry-run --deploy-root /srv/openclaw

# Real deploy from a clean tree:
node scripts/deploy-pipeline.mjs deploy --clean --deploy-root /srv/openclaw

# Inspect, then roll back the last activation if needed:
node scripts/deploy-pipeline.mjs list --deploy-root /srv/openclaw
node scripts/deploy-pipeline.mjs rollback --deploy-root /srv/openclaw

# Reclaim space, keeping the 5 newest plus the active and rollback targets:
node scripts/deploy-pipeline.mjs prune --keep 5 --deploy-root /srv/openclaw
```

Verification and staging can also run as separate steps in CI: `build` produces
and verifies the dist, `stage` archives it as a release artifact, and a later
job runs `activate` on the target host.

## Related

Collaborators running the fork patch line install, update, and roll back through
this pipeline. See [Kynver patch channel](/install/kynver-patch-channel) for the
repo, branch, and commit guidance, the update guard that keeps stock
`openclaw update` from clobbering the fork, and the operator workflow.
