---
summary: "Switching install types, the source-server script, re-running the installer, and manual npm/pnpm/bun updates"
read_when:
  - You want to switch an install between a package manager and a git checkout
  - You run a gateway directly from a git checkout on a server
  - You need to update or recover OpenClaw with npm, pnpm, or bun directly
title: "Other update methods"
sidebarTitle: "Update methods"
---

Install-type switching, the source-server reference script, the installer, and manual package-manager updates. Part of the [Updating](/install/updating) guide.

## Switch between npm and git installs

Installer-driven switches verify the replacement before the working owner is retired. Source wrappers are published atomically; same-path npm shim transitions use an identity-checked backup that is restored on failure, so a failed candidate leaves the previous command runnable. Before retiring an old source wrapper, the updater rechecks its identity and contents and confirms that it still owns the update. The `openclaw update` command prints its final success result only after post-core convergence and requested restart health checks succeed.

Candidate validation failures leave the old Gateway serving. After activation,
package recovery can restore the retained previous package only when the shared
and affected pre-existing per-agent database schema versions are unchanged and
configuration has not changed since the candidate’s activation Doctor pass. A database first created by the candidate is neutral only
at its supported schema version for that database kind. The restored
Gateway must pass the same runtime checks before recovery is reported as
complete. A schema migration prevents automatic package rollback; replacing
code cannot undo migrated state. Incomplete file rollback retains its backups
for inspection. See [Automatic rollback](/install/updating#automatic-schema-neutral-rollback).
If an older target does not support preserving the service definition, automatic
recovery stops and reports the error without retrying with weaker options. Repair
the reported failure, rerun `openclaw update`, and check `openclaw gateway status --deep`.
See [Failed update recovery](/gateway/restart-recovery#recovery-after-a-failed-update).

On macOS, if Doctor reports an installed but unloaded and disabled Gateway
LaunchAgent after an interrupted update, finish update verification or Doctor and
triage first. Then use the printed `openclaw gateway start` command, preserving
its profile and state/config or custom-label overrides. `doctor --fix` diagnoses
the disabled label but leaves an already-stopped Gateway stopped.

Use channels to change the install type. The updater keeps your state, config,
credentials, and workspace in `~/.openclaw`; it only changes which OpenClaw
code install the CLI and gateway use.

```bash
# npm package install -> editable git checkout
openclaw update --channel dev

# git checkout -> npm package install
openclaw update --channel stable
```

Preview the install-mode switch first:

```bash
openclaw update --channel dev --dry-run
openclaw update --channel stable --dry-run
```

`dev` ensures a git checkout, builds it, and installs the global CLI from that
checkout. The `stable`, `extended-stable`, and `beta` channels use package
installs. Extended-stable is rejected on a git checkout without mutating or
converting it. If the gateway is already installed, `openclaw update` refreshes
the service metadata and restarts it unless you pass `--no-restart`.

Automatic package-to-Git conversion currently requires an npm-owned package
symlink. A pnpm- or Bun-owned install rejects `--channel dev` before stopping
the Gateway; use the [Git installer](/install/installer) when changing that
installation's owner. Normal package-to-package updates keep using pnpm or Bun.

Git updates build the complete runtime, including plugins and the Control UI,
in a temporary candidate worktree. Dev updates preserve local commits by
rebasing the candidate before its build. The updater publishes that prepared
runtime during activation instead of repeating the build while stopped. It
preserves the build timestamps, so ordinary CLI commands keep using that
validated runtime without regenerating it after the move.
Candidate installs and nested build commands use a private pnpm virtual store,
so preparing an update cannot prune dependencies used by the serving Gateway.
The candidate's temporary workspace settings are restored before checking for
source changes; the live checkout's workspace settings are preserved.

For package installs with a managed Gateway service, `openclaw update` targets
the package root used by that service. If the shell `openclaw` command comes
from a different install, the updater prints both roots and the managed
service's Node path, and checks that Node version against the target release's
`engines.node` requirement before replacing the package.

## Source-checkout servers (reference script)

Before manually rebuilding a source checkout, stop every Gateway serving its
`dist` files. Build entry points inspect discoverable managed Gateways, including
sibling profiles, and refuse when a live service shares that output. On systemd,
this includes processes remaining in the service cgroup after its main PID exits.
Use an external terminal, outside the running Gateway's agent session. Follow the
reported service/profile stop commands, rebuild, then start those same services.
For the default profile, run these commands from the source checkout:

```bash
openclaw gateway stop &&
pnpm build &&
openclaw gateway start
```

Stop every listed sibling before building and start each one afterward. Preserve
its profile and custom service overrides, or use the matching native service
commands. A Startup-only sibling must be stopped using the exact Startup-file
guidance and restarted through that same Startup entry; updating the selected
service cannot stop that sibling. Start services only after the build succeeds.
`openclaw update` can apply an available update, but `skipped` / `already-current`
does not rebuild stale `dist`; use the external stop, rebuild, and start sequence
for that case.

A separate candidate checkout with independent output can build while the installed Gateway
continues serving. This check observes current services; it does not prevent a
service from starting during compilation, and unavailable inspection does not
prove that no Gateway is running.

Teams running a gateway directly from a git checkout on a server can update it
with `scripts/update-gateway.sh` from inside that checkout. It is the reference
for a source-server update: it fails closed on all tracked local changes,
including build outputs, fast-forwards `main` (or rebases a local server branch
onto `origin/main`), installs dependencies with a frozen lockfile, builds clean,
and stops the gateway before replacing its build output. If the build fails, it
restores the previous output and restarts that build while still returning the
build failure.

Like `openclaw update`, the script builds runtime JavaScript, plugin assets, and
the Control UI without generating TypeScript declarations by default. Set
`OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0` when invoking the script if this checkout
also needs fresh declarations for plugin development.

This reference script requires **Corepack** and creates temporary shims without
global activation before fetching. After fetching, it freezes the target commit
and checks that its exact pnpm pin can run through those shims in a private probe
workspace. The probe contains only package-manager metadata, not the target's
dependencies, hooks, or configuration. Missing or invalid metadata, provisioning
failure, or a version mismatch stops before checkout update or restart; repair
the target pin or install a compatible Corepack, then retry.

The same fetched commit is used for fast-forward or rebase. This is a fetched-target
toolchain preflight, not a complete preflight of a rebased local branch or its
build. The build rollback covers generated output, not Git, installed dependencies,
or configuration. Local branch overrides remain in effect: install and build resolve the resulting
checkout's pin, which may differ from the probed target pin. Operators must verify
those overrides and maintain a recovery path. The same shim directory leads
nested commands' `PATH`, and child workspace and lockfile roots follow each
operation's directory. Bootstrap or install failure leaves service lifecycle
untouched. During the build, the updater owns all generated output roots, including
package-local `dist` directories. If restoration cannot finish or build writers
have not stopped, it leaves the service stopped and reports the retained backup
path. If restart of a successful new build fails, it retains the previous output
without replacing chunks that a new process may already be using.
The hosted [installers](/install/installer) also support npm-owned temporary provisioning
when Corepack is unavailable; this server script deliberately requires Corepack.

<Warning>
A running older updater or server script keeps its old bootstrap code even if it
checks out files containing this repair. If that older entry point invokes
ambient pnpm, the operator must select a target-compatible pnpm launcher before
the first update across the pin change. Validate that launcher against both the
intended target and the known-good rollback ref before starting the update.
Updating target files alone does not repair an older running binary.
</Warning>

The published 2026.9.4 source-server script also builds before its final restart.
Candidate build entry points recognize its existing update marker only when the
selected, natively owned Gateway serves this checkout's physical `dist`. The
existing source-build transaction stops that Gateway before writing and restores
the previous output on a settled build failure. A separate candidate checkout or
a sibling-only match never grants permission to stop another service.
If that native stop partially succeeds and then fails, the candidate revalidates
and restarts the original service through its native owner, without running a
custom shell command or starting the build. The original stop failure is still
reported, including any failure to complete recovery.

For that first hop, the old script still owns its one successful restart,
including an authored custom restart command. Its empty or whitespace-only
restart setting remains manual and does not trigger an automatic stop. The old
script cannot receive the candidate process's recovery state: after a successful
build, the candidate settles native autostart and retires its build backup before
returning. A subsequent old-script restart failure therefore requires operator
recovery; it does not gain the newer script's retained-backup guarantee. Unjoined
build writers or failed output restoration leave the Gateway stopped and retain
recovery material.

Generated output roots such as `dist`, `dist-runtime`, and package-local
`dist` directories must be real directories. Builds refuse symbolic-link roots
before reading or mutating their contents so cleanup cannot affect the link
target. Replace an output-root symlink with a real directory before updating or
building a source checkout.

```bash
ssh you@server 'cd /path/to/openclaw && scripts/update-gateway.sh'
```

The default stop command is `openclaw gateway stop --force`, so non-interactive
SSH updates can stop the service. Override both commands for custom service units:

```bash
OPENCLAW_UPDATE_STOP_CMD='systemctl --user stop openclaw-gateway.service' \
OPENCLAW_UPDATE_RESTART_CMD='systemctl --user restart openclaw-gateway.service' \
  scripts/update-gateway.sh
```

Custom automatic commands must be provided together and must not be blank.
An exactly empty restart command keeps the operator-owned manual lifecycle:
stop the Gateway yourself before invoking the script, then restart it yourself
after resolving any failure. Do not also set a stop override in this mode.
The script performs no automatic stop, restart, or build-output rollback:

```bash
OPENCLAW_UPDATE_RESTART_CMD='' scripts/update-gateway.sh
```

For a plain single-user source install, prefer `openclaw update --channel dev`
instead — it manages the checkout, build, and gateway restart for you.

## Alternative: re-run the installer

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Add `--no-onboard` to skip onboarding. To force a specific install type, pass
`--install-method git --no-onboard` or `--install-method npm --no-onboard`.

If `openclaw triage` cannot start after a failed npm package replacement, re-run
the installer. It runs the global package install directly and can recover a
partially updated npm install. Keep an unverified Gateway stopped while repairing it.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm
```

Pin the recovery to a specific version or dist-tag with `--version`:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --version <version-or-dist-tag>
```

## Homebrew formula installs

For `brew install openclaw-cli`, update through Homebrew:

```bash
brew upgrade openclaw-cli
openclaw gateway restart
```

`openclaw update` leaves the formula unchanged and prints these commands. Existing
profiles retain that skipped outcome and guidance in `openclaw update status --json`
and the update report. Stop a running Gateway before a manual upgrade to avoid
loading files from a removed keg; back up first and run `openclaw doctor --fix`
before restarting.

New or refreshed service definitions use Homebrew's stable `opt/openclaw-cli`
path. To repair a service still pointing at a versioned `Cellar` path, run
`openclaw gateway install --force` from the upgraded CLI. Global npm packages
under the Homebrew prefix continue to use npm.

## Alternative: manual npm, pnpm, or bun

The npm command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm i -g openclaw@latest --allow-scripts=openclaw
```

Prefer `openclaw update` for supervised installs: it can coordinate the package
swap with the running Gateway service. If you update manually on a supervised
install, stop the managed Gateway first. Package managers replace files in
place, and a running Gateway can otherwise try to load core or plugin files
mid-swap. Restart the Gateway after the package manager finishes so it picks up
the new install.

Gateways with installation-replacement detection also check the installed build
on their maintenance tick. If the running and installed builds differ, the
Gateway records the replacement, stops accepting new work, and gives active work
its existing bounded shutdown window before handing over to its service manager.
A foreground Gateway exits with instructions to run `openclaw gateway run` again.
Status and Doctor report the replacement while the Gateway drains. Afterward,
`openclaw gateway status --deep`, `openclaw update status`, and Doctor show the
recorded replacement as historical information until the next Gateway shutdown.
This record does not by itself confirm that the new Gateway is healthy.
If a reply's delivery module disappears before sending starts, the reply remains
eligible for recovery instead of being treated as an uncertain send.
This recovery cannot prevent every failure during a package manager's in-place
swap, and older running Gateways do not gain it from files installed underneath
them. `openclaw update` remains the supported path for coordinating replacement.

Release packages include generated compatibility files for lazy imports from
updaters in the supported upgrade window, including the 2026.9.1 service restart path. These
files let the old updater finish after its installation is replaced. They do not
preserve a running Gateway's old module state, cover arbitrary plugin imports,
or make rollback into an older published package safe without restarting.

For a root-owned Linux system-global install, if `openclaw update` fails with
`EACCES`, recover with system npm while keeping the Gateway stopped for the
manual replacement. Use the same profile flags/environment you normally use for
that Gateway. Replace `/usr/bin/npm` with the system npm that owns the
root-owned global prefix on your host:

The npm command below follows the same version contract: use the flag on npm 12
or npm 11.16+, and omit it on npm 11.15 and earlier.

```bash
openclaw gateway stop
sudo /usr/bin/npm i -g openclaw@latest --allow-scripts=openclaw
openclaw gateway install --force
openclaw gateway restart
```

Then verify:

```bash
openclaw --version
curl -fsS http://127.0.0.1:18789/readyz
openclaw plugins list --json
openclaw gateway status --deep --json
openclaw doctor --lint --json
```

When `openclaw update` manages a global npm install, it installs the target
into a temporary npm prefix first. The candidate package validates the host
Node version during `preinstall`; OpenClaw verifies the packaged `dist` inventory
before swapping the clean package tree into the real global prefix. Pending
lifecycle work is recorded in `.openclaw-lifecycle-pending` at the package root,
outside the `dist` inventory. `postinstall` removes that marker after completion.
If package scripts were skipped, the CLI completes the pending lifecycle before
running any command, including `--version`; failure stops the command with
reinstall guidance. The updater probes the owning npm before mutation. On npm
11.15 and earlier it omits the unsupported lifecycle-policy flag. On npm 12 and
npm 11.16+, it approves only the candidate OpenClaw lifecycle; transitive
dependency scripts remain unapproved.
This avoids npm overlaying a new package onto stale files from the old one. If
the install command fails, OpenClaw retries once with `--omit=optional`, which
helps hosts where native optional dependencies cannot compile.
The packaged lifecycle restores the matching precompiled fs-safe dependency
when that retry omitted it. It uses the version declared by the installed
fs-safe package and does not run dependency build scripts. A working native
binding needs no extra download. Unsupported hosts or failed downloads produce
a warning and allow installation to finish; explicitly disabling fs-safe native
support also skips this repair.

For local tarball targets on npm 12, the archive filename and every parent
directory must be comma-free. See [Installer path requirements](/install/installer).

OpenClaw-managed npm update and plugin-update commands also clear npm's
`min-release-age` supply-chain quarantine (or the older `before` config key)
for the child npm process. That policy exists for general protection, but an
explicit OpenClaw update means "install the selected release now."

```bash
pnpm add -g --allow-build=openclaw openclaw@latest
```

If pnpm 11 installed OpenClaw 2026.7.1, run that manual command once. That
release predates pnpm 11's isolated global-package layout, so its updater can
mistake another npm installation for the running CLI. Later releases retain
pnpm ownership and follow the replacement package root during updates. They
also use the owning manager's reported global bin directory and stop before
mutation when the available pnpm command reports another global root,
or when the invoking package is orphaned or not the only active OpenClaw
install there.

pnpm 12 retains the `global/v11` layout; the layout number does not need to match
the pnpm CLI major version.
Staged pnpm updates isolate both the global project and its launchers. OpenClaw
sets the staging bin through CLI configuration for pnpm 10/11 and child-process
environment configuration for pnpm 12, then verifies both destinations before
installation. A manager that still reports a live destination stops the update
before activation.

If OpenClaw shares a pnpm global install group with another package, the
automatic updater stops before changing the group. Update the original
comma-separated group manually so its sibling packages and build policy stay
intact.

```bash
bun add -g --trust openclaw@latest
```

`--trust` allows OpenClaw's lifecycle scripts. The canonical `openclaw update`
path applies the same OpenClaw-only Bun trust when it owns the install.
On Windows, the staged updater rejects Bun installs before stopping the Gateway
because it cannot relocate Bun's binary launchers. Run
`bun add -g --trust openclaw@<resolved-target-version>` manually, then
`openclaw gateway restart`; verify with `openclaw update status`.

### Package lifecycle and operator state

Package lifecycle hooks validate the Node runtime and update only package-local
artifacts: the installed `dist` tree and lifecycle markers. Plugin-registry and
operator-state migration belong to Doctor, not package installation. Doctor also
removes genuinely dangling global plugin-runtime links, but preserves shared and
versioned runtime caches and valid links to them: other installs or profiles may
still use them. `openclaw update` still runs Doctor after installing the candidate;
after a manual package replacement, run `openclaw doctor --fix` before restarting
the Gateway.

The fresh post-core continuation runs repairing Doctor before plugin convergence,
including when an older updater already ran Doctor without `--fix`. This completes
pending legacy state even when the configuration itself needs no repair.

Doctor also brings drifted active official npm plugins to the installed OpenClaw
release, honoring recorded non-default tags and pins newer than its plugin cohort.
It uses the same plugin updater as `openclaw update` and leaves third-party plugins
unchanged. An unavailable plugin produces a warning with
the reason; it does not prevent the other repairs from completing. Restore
registry access or wait for the missing package, then rerun `openclaw doctor --fix`.

`OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1` skips package-local postinstall
cleanup, but still completes the lifecycle marker. Doctor migrations remain
enabled.

<Warning>
Older packages, including `2026.8.1`, can migrate the state database during
installation even with that postinstall opt-out set. Back up before upgrading.
To evaluate an affected package without changing a working Gateway, use a
disposable environment with separate home, config, and state directories. A
different npm prefix alone does not isolate operator state.
</Warning>

### Stuck on 2026.9.3

The published 2026.9.3 updater has a fixed five-minute limit that can stop an
upgrade before it finishes. A timeout fix in the target release cannot replace
the updater already running. Bypass that older updater once with a manual
package installation.

Create a [verified backup](/install/updating/rollback-and-recovery#before-updating-create-a-verified-backup)
first. Keep the same service account, npm prefix, profile, and state/config
overrides. Stop the Gateway through its owning supervisor before replacing the
package. For a managed npm install:

```bash
openclaw gateway stop
npm install -g openclaw@latest --allow-scripts=openclaw
openclaw doctor --fix
openclaw gateway restart
openclaw gateway status --deep
```

Omit `--allow-scripts=openclaw` on npm 11.15 and earlier. For an external
supervisor, use its stop and restart commands. Doctor keeps an already-stopped
Gateway stopped, so complete the restart after reviewing its repair results.

Automatic official-plugin drift repair was added after 2026.9.5. If the installed
release still prints **Fix each drifted plugin**, run its printed
`openclaw plugins update` commands before restarting. Once installed, a build
with automatic drift repair performs those official-plugin updates during
`doctor --fix`; any remaining readiness warning names the plugin that still
needs attention.

### Advanced npm install topics

<AccordionGroup>
  <Accordion title="Read-only package tree">
    After package lifecycle completion, OpenClaw treats packaged global installs as read-only at runtime, even when the global package directory is writable by the current user. Plugin package installs live in OpenClaw-owned npm/git roots under the user config directory, and Gateway startup does not mutate the OpenClaw package tree.

    Some Linux npm setups install global packages under root-owned directories such as `/usr/lib/node_modules/openclaw`. OpenClaw supports that layout because plugin install/update commands write outside that global package directory.

  </Accordion>
  <Accordion title="Hardened systemd units">
    Give OpenClaw write access to its config/state roots so explicit plugin installs, plugin updates, and doctor cleanup can persist their changes:

    ```ini
    ReadWritePaths=/var/lib/openclaw /home/openclaw/.openclaw /tmp
    ```

  </Accordion>
  <Accordion title="Disk-space preflight">
    Before package updates and explicit plugin installs, OpenClaw tries a best-effort disk-space check for the target volume. Low space produces a warning with the checked path, but does not block the update because filesystem quotas, snapshots, and network volumes can change after the check. The actual package-manager install and post-install verification remain authoritative.

    For package updates, the check runs before registry lookups and database-schema validation. Managed update runs retain the warning in update history so it also appears in the Control UI.

    Before staging a replacement, a read-only snapshot check measures the known SQLite database families, including WAL, SHM, and journal files. Its non-warning diagnostic entries in `openclaw update status --json` record each family's size and the existing snapshot budget: twice the total family bytes, three times the largest family, and 64 MiB for metadata. Plugin copies and registered external databases remain unknown until the complete check after staging.

    Snapshot space is checked at the existing destinations: `TMPDIR`, the capture directory beside the state directory, and the system temporary directory. An update refuses before staging only when every destination has known free space below the snapshot owner's requirement, because its private state copy cannot be taken. Database sizes are inventory for the temporary snapshot, not database-health or growth warnings. A successful check needs no database cleanup. If measurement fails, the updater warns that it will check again after staging. A usable alternative or unknown free-space reading does not itself stop the update. Package and Git targets that are already current need no candidate snapshot. The updater preserves a config copy, not a full-state backup.

    This check runs in the installed updater; an already-installed 2026.9.3 updater retains its prior behavior for its own first upgrade hop.

  </Accordion>
</AccordionGroup>
