---
summary: "Bun runtime requirements, macOS SQLite selection, limitations, and release history"
title: "Bun compatibility"
read_when:
  - You want to check Bun runtime support and limitations
  - You need to select a SQLite library for Bun on macOS
---

Bun is an explicit opt-in runtime for OpenClaw's CLI, Gateway, and managed node host. Node remains the primary and recommended runtime. This reference covers Bun requirements and compatibility; see [Bun](/install/bun) for installation and opt-in steps, or [Node.js compatibility](/install/node-compatibility) for Node requirements.

## Requirements

OpenClaw requires **Bun 1.4.0+**, an available **`node:sqlite`** API, and the same [WAL-safe SQLite floor as Node](/install/node-compatibility#why-the-floors-exist).

| Platform | SQLite library Bun uses                       | Extension loading              | What OpenClaw does                                   |
| -------- | --------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| Linux    | Statically linked SQLite; 3.53.2 in Bun 1.4.2 | Supported                      | No additional library setup needed.                  |
| macOS    | Apple system SQLite by default                | Unavailable in Apple's library | Automatically selects a suitable library; see below. |
| Windows  | Same static SQLite build as Linux             | Supported                      | No additional library setup needed.                  |

The platform defaults come from [Bun's SQLite build policy](https://github.com/oven-sh/bun/blob/bun-v1.4.2/scripts/build/deps/sqlite.ts); the [Bun 1.4.2 version definition](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/jsc/bindings/sqlite/sqlite3_local.h) pins SQLite 3.53.2.

<a id="sqlite-library-selection" />

## SQLite library selection on macOS

Install Homebrew SQLite for native `sqlite-vec` KNN memory queries:

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

Set `OPENCLAW_SQLITE_LIBRARY` in the process environment before starting OpenClaw to override discovery:

```sh
OPENCLAW_SQLITE_LIBRARY=/path/to/libsqlite3.dylib bun openclaw.mjs gateway
```

An invalid override fails with:

```text
Cannot use SQLite library <path>: <reason>. Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.
```

Node and non-macOS Bun ignore this override, with a warning in Gateway startup logs. When a library is selected, Gateway startup logs `SQLite: using <path> (<version>, extension loading enabled)`. `openclaw doctor` reports the selection for the doctor process.

Daemon install, `openclaw gateway start` repair, `openclaw doctor`, and service audits probe candidate Bun executables through the same selection, so they judge and report the library the Gateway will actually open rather than Bun's runtime SQLite. An invalid override fails those probes with the message above instead of advising a Bun upgrade or switching the service to Node.

If you previously used a preload that calls `Database.setCustomSQLite()`, remove it and set `OPENCLAW_SQLITE_LIBRARY` to the same path instead. The hook is one-shot: keeping the preload causes `SQLite already loaded`, even if both selections name the same library. OpenClaw's override also forwards the path to the KNN child.

## Memory search without an extension-capable library

When the KNN child cannot load extensions, memory search falls back to a batched embedding scan. It preserves provider and source filters and cancellation checks between batches, but can be slower on large indexes. See [Memory configuration](/reference/memory-config).

## Known limitations

- **Lifecycle scripts:** Bun blocks dependency lifecycle scripts unless explicitly trusted with `bun pm trust`.
- **Package scripts:** Some scripts hardcode pnpm, so `bun run` still invokes pnpm internally.
- **SQLite handles:** Bun 1.4.2 can retain statement handles and WAL/shared-memory files after `DatabaseSync.close()` or `Symbol.dispose()`; OpenClaw cannot finalize them through Bun's public `node:sqlite` API. See the [upstream close fix](https://github.com/oven-sh/bun/pull/40005); use Node when prompt file release matters.
- **Workspace installation:** `bun install` cannot resolve this repository's pnpm workspace layout. Use `pnpm install`.

See [Bun](/install/bun) for the workflow and lifecycle trust commands.

## History across releases

| Release                            | Change                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreleased (main)                  | Daemon install, repair, doctor, and service audits probe Bun executables through the same SQLite library selection as Gateway startup, with a minimal probe environment. #142186                     |
| Unreleased (main)                  | Automatically selects a WAL-safe, extension-capable macOS SQLite library and propagates it to the memory KNN child. Adds `OPENCLAW_SQLITE_LIBRARY`. #141854                                          |
| Unreleased (main)                  | Documents Bun 1.4.2 retaining native statements and WAL/shared-memory files after close or disposal, with Node advised when prompt file release matters. #141846                                     |
| Unreleased (main)                  | Adds batched embedding-scan fallback when the KNN child cannot load extensions, preserving provider/source filters and cancellation between batches. #141104                                         |
| Unreleased (main)                  | Allows ordinary agent databases on SQLite builds without extension loading. Native vector search still needs an extension-capable library. #139487                                                   |
| v2026.8.2                          | Repairs Bun 1.4 authenticated Gateway WebSocket compatibility with the installed npm receiver, preserving payload limits and request scheduling. #134282                                             |
| v2026.8.1                          | Restores explicit managed-service selection for the CLI, Gateway, and managed node host, requiring Bun 1.4.0+, `node:sqlite`, and WAL-safe SQLite. #129593                                           |
| v2026.7.2-beta.5; stable v2026.8.1 | Restores experimental CLI/Gateway support for builds providing `node:sqlite`, documented as 1.4.0 canary and later; the guard uses an API probe without a numeric Bun minimum at this stage. #114256 |
| v2026.7.2-beta.5; stable v2026.8.1 | Documents `bun install` failing on the pnpm workspace layout and changes dependency instructions to `pnpm install`; Bun remains a script runner. #114256                                             |
| v2026.7.1; main v2026.7.2-beta.1   | Rejects Bun CLI/Gateway use because `node:sqlite` is unavailable, makes managed runtime selection Node-only, and directs legacy Bun services to Node. Package-script use remains available. #106065  |
| v2026.1.12                         | Labels Bun Gateway use experimental and not recommended because of WhatsApp/Telegram bugs; recommends Node for production.                                                                           |
| v2026.1.9                          | Removes Bun from the interactive daemon-runtime picker while the explicit validator still accepts Bun.                                                                                               |
| v2026.1.8                          | Documents Bun as an optional package-script runner for local builds/tests, with optional dependency installation at that time. pnpm remains primary.                                                 |
| v2026.1.8                          | Documents ignored pnpm lockfiles, a historical postinstall patch bridge, lifecycle trust, and scripts that invoke pnpm internally. The patch bridge is not a current install recommendation.         |
| v2026.1.8                          | Introduces optional `--daemon-runtime bun` when WhatsApp is disabled because the Baileys WebSocket reconnect path could corrupt memory under Bun. Node remains the default and recommendation.       |

## Related

- [Bun](/install/bun)
- [Environment variables](/help/environment)
- [Memory configuration](/reference/memory-config)
- [Node.js compatibility](/install/node-compatibility)
