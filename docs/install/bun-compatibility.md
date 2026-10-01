---
summary: "Bun runtime requirements, macOS SQLite selection, limitations, and release history"
title: "Bun compatibility"
read_when:
  - You want to check Bun runtime support and limitations
  - You need to select a SQLite library for Bun on macOS
---

Bun is an explicit opt-in runtime for OpenClaw's CLI, Gateway, and managed node host. Node remains the primary and recommended runtime for those installations. The macOS app uses the OpenClaw Bun fork for its bundled private runtime, described below. This reference covers Bun requirements and compatibility; see [Bun](/install/bun) for installation and opt-in steps, or [Node.js compatibility](/install/node-compatibility) for Node requirements.

## Requirements

OpenClaw requires **Bun 1.4.0+**, an available **`node:sqlite`** API, and the same [WAL-safe SQLite floor as Node](/install/node-compatibility#why-the-floors-exist).

| Platform | SQLite library Bun uses                       | Extension loading              | What OpenClaw does                                   |
| -------- | --------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| Linux    | Statically linked SQLite; 3.53.2 in Bun 1.4.2 | Supported                      | No additional library setup needed.                  |
| macOS    | Apple system SQLite by default                | Unavailable in Apple's library | Automatically selects a suitable library; see below. |
| Windows  | Same static SQLite build as Linux             | Supported                      | No additional library setup needed.                  |

The platform defaults come from [Bun's SQLite build policy](https://github.com/oven-sh/bun/blob/bun-v1.4.2/scripts/build/deps/sqlite.ts); the [Bun 1.4.2 version definition](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/sqlite/sqlite3_local.h) pins SQLite 3.53.2.

## macOS app private runtime

OpenClaw.app bundles a pinned [OpenClaw Bun fork](https://github.com/openclaw/bun),
the full matching OpenClaw package, and a signed SQLite library that meets the
WAL safety floor and supports extension loading. Its private `node worker` and
Chrome-extension setup run on that Bun executable with
`OPENCLAW_SQLITE_LIBRARY` pointing to the bundled library. These helpers need no
Node or Homebrew SQLite installation. Bundled native libraries remain Team-signed;
only the Bun executable disables library validation to load runtime-installed
plugin addons. See the [signing tradeoff](/platforms/mac/signing).

The package includes the CLI, Gateway, Control UI, npm, and `sqlite-vec`, but the
app's Gateway still runs externally. Bundled Gateway hosting is a separate
subsequent change; the app's external CLI installation and launchd management
remain unchanged. See [Gateway on macOS](/platforms/mac/bundled-gateway) and
[macOS developer setup](/platforms/mac/dev-setup).

<a id="sqlite-library-selection" />

## SQLite library selection on macOS

For external Bun installations, install Homebrew SQLite for native `sqlite-vec`
KNN memory queries. The macOS app's private runtime already includes its own
library.

```sh
brew install sqlite
```

Before opening databases, OpenClaw selects a library in this order:

1. An explicit library path supplied internally, otherwise `OPENCLAW_SQLITE_LIBRARY`.
2. `$HOMEBREW_PREFIX/opt/sqlite/lib/libsqlite3.dylib`.
3. `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`.
4. `/usr/local/opt/sqlite/lib/libsqlite3.dylib`.
5. `/opt/local/lib/libsqlite3.dylib` (MacPorts).

Candidates must meet the WAL safety floor and support extension loading before selection. If automatic discovery finds no qualifying library, Bun keeps its runtime library; ordinary agent databases can open if that library meets the WAL floor. The memory KNN child uses the same selected library.

SQLite storage workers inherit the main process's selected library. Opening another database or restarting a storage worker reuses that selection without repeating Bun's one-shot library initialization.

Package-update recovery retains the library selected during Bun admission. On macOS, copy the printed recovery command including its `OPENCLAW_SQLITE_LIBRARY` prefix; it works from a fresh shell without the service environment or custom `HOMEBREW_PREFIX`. If recovery cannot meet the SQLite safety floor, it refuses before opening the journal and names the recorded library input to restore. The version-1 recovery journal format is unchanged.

Set `OPENCLAW_SQLITE_LIBRARY` in the process environment before starting OpenClaw to override discovery:

```sh
OPENCLAW_SQLITE_LIBRARY=/path/to/libsqlite3.dylib bun openclaw.mjs gateway
```

On macOS, `openclaw gateway install --runtime bun`, `openclaw node install --runtime bun`, and wrapper-based installs persist `OPENCLAW_SQLITE_LIBRARY` and `HOMEBREW_PREFIX` from the installing shell into the managed service definition, so the service selects the same library. To change these values for an already-installed service, reinstall with `openclaw gateway install --runtime bun --force` (or `openclaw node install --runtime bun --force` for a managed node host) from a shell with the desired values; a bare reinstall of an already-loaded service is a no-op. Direct Node-runtime services never persist them.

An invalid override fails with:

```text
Cannot use SQLite library <path>: <reason>. Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.
```

Node and non-macOS Bun ignore this override, with a warning in Gateway startup logs. When a library is selected, Gateway startup logs `SQLite: using <path> (<version>, extension loading enabled)`. `openclaw doctor` reports the selection for the doctor process.

Daemon install, `openclaw gateway start` repair, `openclaw doctor`, and service audits probe candidate Bun executables through the same selection, so they judge and report the library the Gateway will actually open rather than Bun's runtime SQLite. An invalid override fails those probes with the message above instead of advising a Bun upgrade or switching the service to Node.

If you previously used a preload that calls `Database.setCustomSQLite()`, remove it and set `OPENCLAW_SQLITE_LIBRARY` to the same path instead. The hook is one-shot: keeping the preload causes `SQLite already loaded`, even if both selections name the same library. OpenClaw's override also forwards the path to the KNN child.

## Memory search without an extension-capable library

When the KNN child cannot load extensions, memory search falls back to a batched embedding scan. It preserves provider and source filters and cancellation checks between batches, but can be slower on large indexes. See [Memory configuration](/reference/memory-config).

## Browser subprocesses

The browser plugin starts its helper processes with the Bun executable that runs OpenClaw, so browser automation needs no separate Node installation:

- **Chrome MCP:** [existing-session profiles](/tools/browser/existing-session) start the packaged Chrome DevTools MCP server on Bun for `--autoConnect`, `browserUrl`, and `wsEndpoint` attaches. Actions, snapshots, screenshots, coordinate clicks, waits across cross-site navigations, and cleanup of the server process tree behave as on Node. A custom `mcpCommand` runs as configured.
- **Chrome extension:** on macOS and Linux, the native messaging host and the relay daemon it starts use the runtime that ran `openclaw browser extension install`.

## Bun-only installs

Pin the Gateway service to your Bun executable so updates and Doctor retain it. Without Node, the `openclaw` launcher cannot start, so run the package entry point with Bun:

```sh
<bun> <package-root>/openclaw.mjs gateway install --runtime bun --runtime-path <bun> --force
```

Update, repair, and Doctor maintenance children use the running Bun executable.
Bun package-manager probes and installs use an explicit executable: the verified
service Bun when updating its root, otherwise `process.execPath` when the updater
runs under Bun, then bare `bun` from PATH as the final fallback. This preserves
the selected Bun even when PATH has no Bun or contains a different build.

When an owned managed Bun Gateway serves a different package root from the CLI,
`openclaw update` advances the Gateway installation in place and leaves the
invoking CLI installation unchanged. The updater validates that service's actual
Bun for Bun 1.4+ and WAL-safe `node:sqlite`, without comparing its emulated Node
version to `engines.node`. If the updater runs on Node, that Node must also meet
the target package's Node and SQLite requirements because finalization uses it.
The existing service install/restart path retains the recorded Bun pin. Node split-root routing is unchanged, and a path under
`~/.openclaw` alone does not establish Bun global-install ownership.

Doctor and `openclaw update repair` from another installation leave this Bun
Gateway at its own root. Explicit repair reports the installation drift and
refuses maintenance before stopping the service. Use
`<bun> <service-root>/openclaw.mjs update repair` or
`<bun> <service-root>/openclaw.mjs doctor --fix` for repair from the service's
installation.

First installs and updater staging without a persistent Node require `OPENCLAW_PACKAGE_BUN_LAUNCHER` set to the absolute Bun executable that launches the CLI. The updater sets it automatically when running under Bun; an app must set it for its first `bun add -g --trust openclaw@<version>`. Preinstall validates that launcher as Bun 1.4+ without spawning absent or nonexecutable Node candidates. Without the marker, preinstall still requires a persistent Node; a Node found on PATH must satisfy the package's Node requirements even when the marker is set.

Published updaters through 2026.9.6 cannot update a Bun-only install. They do not set this marker, so the new package's preinstall stops staging (`global-install-failed`). If the caller sets the marker, their own bare `node` probe fails to start instead (`update-executor-settlement-failed`). Both refusals happen before the Gateway stops, and it keeps running. A fixed version must drive the update; installing a fixed candidate cannot change the updater already running.

The installed updater runs first. In a Linux split-root fixture, published
2026.9.6 refused early with `ENOENT` when Bun was absent from PATH, leaving the
Gateway and both installations unchanged. With the fork Bun on PATH, the same
published driver updated the Gateway installation in place and restarted it
healthy while leaving the invoking CLI unchanged. The routing and explicit
Bun selection described above apply from the first updater containing the fix;
a newer candidate cannot change the installed updater's first-hop behavior.

Npm-sourced plugins use OpenClaw's bundled npm 12.1.0 CLI under Bun and do not require a separate Node or npm installation.

## SQLite worker lifecycle

After selecting SQLite, long-lived Gateway, node, and worker hosts that own SQLite
pools on macOS and Linux await a check of whether Bun's ordinary
`DatabaseSync.close()` and `Symbol.dispose()` release native statements and WAL
resources. The check runs once in a small isolated worker; it uses behavior, not
the Bun version string. Short CLI paths do not run it. A passing result enables
the shared writer pool and targeted reader cleanup used on Node.

Stock Bun 1.4.2 fails this check and retains the conservative lifecycle below.
Errors, timeouts, and unsupported WAL behavior also keep that lifecycle and record
the reason. A timeout or error returns the conservative decision without waiting
for worker cleanup. Cleanup waits up to five seconds for worker exit before
removing its private files. An unconfirmed exit leaves the worker unreferenced
and its directory intact, with a `SQLITE_CLOSE_PROBE_CLEANUP` warning naming the
retained path. A passing probe also uses this bounded join before accepting success.
Windows Bun stays conservative without running the check until Windows
conformance is qualified. Before the result is available, per-operation readers
and close paths use conservative cleanup without fixing the global decision;
later operations can use the completed result. Each writer broker fixes placement,
native-stop acknowledgement, and retirement policy together when it is created.
An early conservative broker keeps that policy even if the check later passes,
with a one-time `SQLITE_EARLY_TOPOLOGY` warning explaining its retained layout. Workers inherit the
decision at creation; those started before it completes remain conservative for
their lifetime, while later workers inherit the completed result.

The result is never saved in config or state. Each new long-lived host checks its
selected runtime and library again, including after an upgrade, downgrade, or rollback.
No schema or data migration is needed, and the installed updater is unchanged.
An inconclusive capability check does not block an otherwise supported runtime;
the existing runtime and SQLite safety requirements still apply.

For internal comparisons, set `OPENCLAW_DIAGNOSTICS=sqlite.close.conservative`
before starting Bun. This exact normalized entry skips the probe and records a
decided conservative result with its reason; wildcard or all-diagnostics entries
do not change the policy. It cannot force a positive capability, does not affect
Node's capability, and is read only from the process environment, never saved in
config or state. Gateway startup logs include the decision and its reason.

## Known limitations

- **Text boundaries:** OpenClaw works around a [JSC segment lookup bug](https://github.com/oven-sh/WebKit/pull/753) that can include the preceding cluster when a lookup starts on an emoji's high surrogate. Message chunking and terminal cells preserve the intended grapheme boundaries on Bun without runtime configuration changes.
- **Desktop WebSockets:** OpenClaw uses the installed `ws` transport for desktop observers and paired-node desktop/portal streams. Bun 1.4.2's built-in `ws` server adapter lacks pause/resume and the Duplex stream bridge; the installed transport preserves backpressure, payload limits, and cleanup when a desktop disconnects.
- **Lifecycle scripts:** Bun blocks dependency lifecycle scripts unless explicitly trusted with `bun pm trust`.
- **Package scripts:** Some scripts hardcode pnpm, so `bun run` still invokes pnpm internally.
- **PTY terminals:** macOS and Linux use Bun's native PTY without a Node runtime only on builds providing `Bun.Terminal.pause()` and `Bun.Terminal.resume()`, such as the OpenClaw Bun fork builds that also carry the [macOS child-exit fix](https://github.com/openclaw/bun/pull/11). Other Bun releases use the Node helper and require an installed Node runtime for terminal I/O. OpenClaw skips Bun's `node` shim when selecting that runtime, including under `bun --bun`. Windows keeps `node-pty`.
- **Windows browser extension:** native messaging registration accepts only `node.exe` as the host interpreter. Run `openclaw browser extension install` with Node on Windows.
- **Launched desktop apps:** Node marks inherited descriptors close-on-exec at startup and Bun 1.4.2 does not, so an app that Gateway computer control launches inherits the helper's standard streams. The Gateway's 30-second cleanup timeout then stops the app when its execution closes. OpenClaw's Bun fork adopts Node's behavior in [openclaw/bun#12](https://github.com/openclaw/bun/pull/12).
- **SQLite handles:** Bun builds that fail the [native-close capability check](/install/bun-compatibility#sqlite-worker-lifecycle), including stock Bun 1.4.2, can retain statement handles and WAL/shared-memory files after close or disposal. OpenClaw cannot finalize them through Bun's public `node:sqlite` API and waits for worker exit. Builds with the [upstream close fix](https://github.com/oven-sh/bun/pull/40005) can use targeted cleanup after passing the check. Windows and processes without completed admission retain the conservative policy.
- **Shared-state reads:** Successful reads reuse their worker and native reader on both lifecycle policies. With the native-close capability, idle readers close after 30 minutes and targeted cleanup can retain the worker. Without it, closing or replacing a reader waits for worker exit, including host-requested cleanup; idle readers retire with their worker, and transcript discovery retires its worker before releasing captured database aliases. Failed reads and uncertain cleanup retain their existing retirement rules on every runtime.
- **SQLite storage workers:** A Bun broker created without the native-close capability uses one worker per distinct database, up to 64 dedicated workers within the host's 64-client cap. Clients of the same database share its worker, and closing the last client waits for worker exit. Capacity exhaustion rejects new work without interrupting existing stores. Node and Bun brokers created with the capability multiplex databases across two to eight shared workers based on available CPUs; a confirmed close releases only the closed actor, while failed or empty slots still retire.
- **Headless node updates on Windows:** a node host running on Bun still prepares updates with npm because Bun's Windows binary launchers cannot be staged. A Windows Bun-only host logs that failure at each hourly check and keeps running its current version.
- **Workspace installation:** `bun install` cannot resolve this repository's pnpm workspace layout. Use `pnpm install`.

See [Bun](/install/bun) for the workflow and lifecycle trust commands.

## History across releases

| Release                            | Change                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreleased (main)                  | Reuses SQLite workers after a native-close check passes on macOS or Linux. Stock Bun 1.4.2, Windows, and inconclusive checks retain conservative cleanup.                                             |
| Unreleased (main)                  | Runs the macOS app's private worker and Chrome setup on the OpenClaw Bun fork, bundling the full package and signed extension-capable SQLite in one shared runtime. Gateway hosting remains external. |
| Unreleased (main)                  | Headless node updates on macOS and Linux fetch and verify registry archives in-process and prepare private runtimes with Bun, without Node or npm. Windows preparation still requires npm. #160575    |
| Unreleased (main)                  | Updates owned split-root Bun Gateway installations in place, retains their runtime pins, and uses explicit Bun executables for package-manager probes and installs.                                   |
| Unreleased (main)                  | Keeps Bun maintenance children and service runtime selection, and adds `OPENCLAW_PACKAGE_BUN_LAUNCHER` for preinstall validation of Bun-only installs and updater staging.                            |
| Unreleased (main)                  | Headless node update checks read the npm registry in-process under Bun instead of running `npm view`. #160154                                                                                         |
| Unreleased (main)                  | Runs the bundled npm 12.1.0 CLI under Bun for npm-sourced plugin installs, updates, and removal without a separate Node or npm installation.                                                          |
| Unreleased (main)                  | Implicit Gateway and managed node host reinstalls, update refresh, and Doctor's unloaded-service reinstall retain a supported recorded Bun executable without creating a runtime pin.                 |
| Unreleased (main)                  | Tool Search code mode (`tool_search_code`) is retired; structured Tool Search needs no Node under Bun.                                                                                                |
| Unreleased (main)                  | Starts the packaged Chrome DevTools MCP server with the current runtime, so existing-session browser profiles no longer require a Node installation under Bun.                                        |
| Unreleased (main)                  | Gateway computer control runs its host worker on the Gateway's own runtime, so a Bun Gateway controls its managed desktop without an installed Node.                                                  |
| Unreleased (main)                  | Uses native PTYs without Node on macOS/Linux with `Terminal.pause()`/`resume()` (OpenClaw fork with macOS exit fix); other Bun builds keep the Node helper. Windows keeps `node-pty`.                 |
| Unreleased (main)                  | Expands Bun SQLite storage from four databases to up to 64 dedicated workers within the existing 64-client cap while retaining worker-exit cleanup.                                                   |
| Unreleased (main)                  | Managed Bun services on macOS persist OPENCLAW_SQLITE_LIBRARY and HOMEBREW_PREFIX from the installing shell.                                                                                          |
| Unreleased (main)                  | Daemon install, repair, doctor, and service audits probe Bun executables through the same SQLite library selection as Gateway startup, with a minimal probe environment. #142186                      |
| Unreleased (main)                  | Automatically selects a WAL-safe, extension-capable macOS SQLite library and propagates it to the memory KNN child. Adds `OPENCLAW_SQLITE_LIBRARY`. #141854                                           |
| Unreleased (main)                  | Documents Bun 1.4.2 retaining native statements and WAL/shared-memory files after close or disposal, with Node advised when prompt file release matters. #141846                                      |
| Unreleased (main)                  | Adds batched embedding-scan fallback when the KNN child cannot load extensions, preserving provider/source filters and cancellation between batches. #141104                                          |
| Unreleased (main)                  | Allows ordinary agent databases on SQLite builds without extension loading. Native vector search still needs an extension-capable library. #139487                                                    |
| v2026.8.2                          | Repairs Bun 1.4 authenticated Gateway WebSocket compatibility with the installed npm receiver, preserving payload limits and request scheduling. #134282                                              |
| v2026.8.1                          | Restores explicit managed-service selection for the CLI, Gateway, and managed node host, requiring Bun 1.4.0+, `node:sqlite`, and WAL-safe SQLite. #129593                                            |
| v2026.7.2-beta.5; stable v2026.8.1 | Restores experimental CLI/Gateway support for builds providing `node:sqlite`, documented as 1.4.0 canary and later; the guard uses an API probe without a numeric Bun minimum at this stage. #114256  |
| v2026.7.2-beta.5; stable v2026.8.1 | Documents `bun install` failing on the pnpm workspace layout and changes dependency instructions to `pnpm install`; Bun remains a script runner. #114256                                              |
| v2026.7.1; main v2026.7.2-beta.1   | Rejects Bun CLI/Gateway use because `node:sqlite` is unavailable, makes managed runtime selection Node-only, and directs legacy Bun services to Node. Package-script use remains available. #106065   |
| v2026.1.12                         | Labels Bun Gateway use experimental and not recommended because of WhatsApp/Telegram bugs; recommends Node for production.                                                                            |
| v2026.1.9                          | Removes Bun from the interactive daemon-runtime picker while the explicit validator still accepts Bun.                                                                                                |
| v2026.1.8                          | Documents Bun as an optional package-script runner for local builds/tests, with optional dependency installation at that time. pnpm remains primary.                                                  |
| v2026.1.8                          | Documents ignored pnpm lockfiles, a historical postinstall patch bridge, lifecycle trust, and scripts that invoke pnpm internally. The patch bridge is not a current install recommendation.          |
| v2026.1.8                          | Introduces optional `--daemon-runtime bun` when WhatsApp is disabled because the Baileys WebSocket reconnect path could corrupt memory under Bun. Node remains the default and recommendation.        |

## Related

- [Bun](/install/bun)
- [Environment variables](/help/environment)
- [Memory configuration](/reference/memory-config)
- [Node.js compatibility](/install/node-compatibility)
