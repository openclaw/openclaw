---
summary: "Bun workflow for installs, package scripts, and opt-in runtime use"
read_when:
  - You want to install dependencies or run package scripts with Bun
  - You want to run OpenClaw with Bun 1.4+
  - You hit Bun install/patch/lifecycle script issues
title: "Bun"
---

<Warning>
Node remains OpenClaw's primary, default, and recommended runtime. Bun 1.4+ builds that provide WAL-reset-safe `node:sqlite` can run the CLI, Gateway, and managed node host as an explicit opt-in. [OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x](/install/bun-compatibility); older Bun versions and builds with unsafe SQLite are rejected.
</Warning>

Desktop apps manage their own runtime: the native macOS app and fresh local
Tauri installations on Linux use the same pinned OpenClaw Bun fork. Existing
Linux Tauri installations retain their runtime across startup and app updates
until you explicitly choose **Use bundled runtime…**. macOS Tauri keeps its
existing behavior, separate from the native macOS app. See
[Linux companion](/platforms/linux#adopt-the-bundled-runtime).

Bun remains usable as an optional package-script runner. The default package manager remains `pnpm`, which is fully supported and used by docs tooling. Bun cannot use `pnpm-lock.yaml` and ignores it, and current Bun versions fail to resolve this repo's `pnpm-workspace.yaml` layout during `bun install`, so dependency installs should use `pnpm install`.

## Install

<Steps>
  <Step title="Install dependencies">
    ```sh
    pnpm install
    ```

    Bun cannot resolve this repo's pnpm workspace layout, so `bun install` fails during workspace resolution. Use `pnpm install`.

  </Step>
  <Step title="Build and test">
    ```sh
    bun run build
    bun run vitest run
    ```

    Use Node by default for commands that launch OpenClaw.

    When running from source under Bun, workers that reuse the current executable use Bun's native TypeScript support even if the executable has a custom filename. Workers that explicitly require Node keep their Node loader.

  </Step>
  <Step title="Run OpenClaw with Bun">
    To run onboarding under Bun and install the managed Gateway under Bun:

    ```sh
    bun --no-install openclaw.mjs onboard --install-daemon --daemon-runtime bun
    ```

    For a managed node host, select Bun separately:

    ```sh
    bun --no-install openclaw.mjs node install --runtime bun
    ```

  </Step>
</Steps>

OpenClaw adds `--no-install` to its Bun service commands and owned runtime
subprocesses, including plugin-integrated exec secret providers. Missing imports
fail instead of fetching packages, even when the working directory's `bunfig.toml`
sets `[install] auto = "fallback"`. Install required dependencies explicitly.
Existing service definitions receive the flag during normal service reinstall or
update; no state migration is needed. This does not control processes that
third-party plugins launch themselves. Use `--no-install` when invoking stock Bun
directly, as shown above.

## Bun-only global install

With a supported [OpenClaw Bun fork](/install/bun-compatibility) executable:

```sh
OPENCLAW_PACKAGE_BUN_LAUNCHER=/absolute/path/to/bun /absolute/path/to/bun add -g --trust openclaw
export PATH="$(/absolute/path/to/bun pm bin -g):$PATH"
openclaw --version
openclaw status --json
```

On macOS and Linux without Node, the trusted package lifecycle installs a launcher
that uses that exact Bun executable. Updates preserve it. To repair an older or
missing launcher, run `/absolute/path/to/bun <package-root>/openclaw.mjs doctor --fix`.
Paths with spaces, quotes, dollar signs, backticks, backslashes, and globs remain
literal. Paths containing newlines or carriage returns require explicit Bun
invocation instead of a generated launcher.
See [Bun-only installs](/install/bun-compatibility#bun-only-installs) for update,
rollback, and custom-bin behavior.

## Lifecycle scripts

Bun blocks dependency lifecycle scripts unless explicitly trusted. For this repo, the commonly blocked scripts are not required:

- `baileys` `preinstall`: checks Node major >= 20 (OpenClaw requires Node 24.16+ or 26.1+, with Node 26 recommended)
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes (no build artifacts)

If you hit a runtime issue that needs these scripts, trust them explicitly:

```sh
bun pm trust baileys protobufjs
```

## Caveats

On macOS, run `brew install sqlite` first: OpenClaw on Bun refuses Apple's system SQLite, which also lacks native vector search. Bun 1.4.2 can retain SQLite handles and WAL/shared-memory files after close; use Node when prompt file release matters. See [Bun compatibility](/install/bun-compatibility) for library selection, requirements, and limitations.

Some package scripts hardcode `pnpm` internally (for example `check:docs`, `ui:*`, `protocol:check`). Running them via `bun run` still shells out to `pnpm`, so just run those via `pnpm` directly.

Repository npm packaging helpers run the packaged npm CLI directly under Bun,
including on Windows. They do not require npm beside the Bun executable. An
explicitly selected Node toolchain still uses its own adjacent npm installation.

Gateway process inspection recognizes Bun's `--watch` and `--hot` flags. ACP bridge detection recognizes Bun and the current runtime executable, including custom filenames. Portable cloud worker archives target Node when built with either runtime, and worker inference errors omit runtime stack properties from their bounded diagnostic messages.

## Known limitations

### Updating from 2026.9.7 with an older system Node

The 2026.9.7 CLI puts trusted system directories (`/usr/bin`, `/bin`) ahead of
the user's `PATH` to protect against binary hijacking. With a Bun-hosted updater,
npm can therefore run the target version's install checks with an older system
Node, even when a supported Node is on the caller's `PATH`. If that Node is below
the supported floor, staging refuses the update and leaves the existing install
untouched. This limitation affects updates driven by **2026.9.7**.

For this one update, run **both the Gateway and updater on supported Node 24**,
then switch back to Bun. Switching only the updater is insufficient. The verified
sequence used Node 24.19.0 and completed the update in 270.9 seconds:

```sh
runtime=/path/to/node-24/bin/node
bun=/path/to/bun
package=/path/to/lib/node_modules/openclaw
export PATH="/path/to/node-24/bin:$PATH"

"$runtime" "$package/openclaw.mjs" gateway install --runtime node --runtime-path "$runtime" --force --json
```

Use your actual absolute paths and the same installation prefix, profile, and
state/configuration as your Gateway. Wait for the Node Gateway to be ready, then
run the normal update:

```sh
"$runtime" "$package/openclaw.mjs" update --yes
```

To target a specific version or a local package, add `--tag <version>` or `--tag ./openclaw.tgz` (see [Update](/cli/update)).

Only after the update succeeds, restore Bun:

```sh
"$bun" "$package/openclaw.mjs" gateway install --runtime bun --runtime-path "$bun" --force --json
```

Wait for the Bun Gateway to be ready, then verify its status:

```sh
"$bun" "$package/openclaw.mjs" gateway status --json
```

### Rollback finalization on 2026.9.7

After an update failure, the 2026.9.7 updater can restore the previous install
byte-for-byte, then wait for Gateway readiness before reporting that rollback
succeeded, even with `--no-restart`. Verified Node and Bun runs both waited about
20 minutes with `--timeout 1200`; this is not specific to Bun. Let the updater
finish, then follow its printed recovery command. If the
Gateway service is stopped, run `openclaw gateway start`, or run
`openclaw doctor` for recovery guidance (invoke it with Bun explicitly if needed,
as shown above). A successful package rollback does not
mean the failed update succeeded or that Gateway readiness was verified.

## Related

- [Bun compatibility](/install/bun-compatibility)
- [Install overview](/install)
- [Node.js compatibility](/install/node-compatibility)
- [Updating](/install/updating)
