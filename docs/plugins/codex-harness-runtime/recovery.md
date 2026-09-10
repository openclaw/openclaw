---
summary: "Orphaned Codex app-server process detection and cleanup after a hard Gateway stop"
read_when:
  - A Gateway stop left Codex app-server processes behind
  - A fresh stdio connection refuses to spawn
title: "Codex process recovery"
sidebarTitle: "Process recovery"
---

What OpenClaw does about registered Codex app-server children when the Gateway stops without cleaning up. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Recovery after a hard Gateway stop

On POSIX systems, OpenClaw checks for registered orphaned Codex app-server
processes before spawning each fresh stdio child. Gateway startup also runs a
best-effort background sweep; the before-spawn check remains authoritative.
OpenClaw records the parent and child process identities in the current state
directory's SQLite plugin store
before sending Codex `initialize`, so a child cannot start a native turn before
its registration is durable.

Cleanup only targets a registered child whose original OpenClaw parent is no
longer running. It checks process IDs, start times, and process groups before
terminating the orphan and its discoverable descendants. When recorded, a
fingerprint of the child command line must also match the live process before
signaling; the durable registration stores only that digest, never the raw
arguments. Another live
OpenClaw instance, processes registered under another state directory, and externally
managed WebSocket or Unix-socket app-servers are left alone. These portable
process checks do not provide an atomic operating-system ownership guarantee
or discover descendants that independently reparented before inspection.

Linux reads process identities directly from `/proc`, including the boot ID
and process start ticks, so Alpine/BusyBox installations do not need `procps`.
Startup identity and command inspection share a 10-second deadline. During Linux
startup, an empty command line waits within that deadline while the same live
process identity remains valid. Registration still
requires a usable command fingerprint; unreadable or changed identities fail.
macOS uses its native `ps` with a fixed locale and timezone. Registration checks
inspect only the observer and the relevant parent and child processes; an
unrelated unreadable process does not block those checks. Destructive cleanup
still requires full process-tree inspection and fresh identity checks before
signaling.

If a required process cannot be inspected or bounded cleanup cannot confirm that
the registered orphan is gone, the new stdio connection fails instead of spawning
another child. Follow the reported reason: a deadline failure calls for checking
host load and Gateway logs, while an access-denied failure calls for checking
`/proc` access on Linux or `ps` permissions on macOS. Other inspection failures
require checking that the process-inspection facility is available and returning
usable data. Do not broaden permissions to address a timeout. If cleanup cannot
stop a verified orphan, inspect and stop that process before retrying. If the
cleanup budget expires, retry to finish the remaining registrations.

This recovery requires a spawn-time registration. It does not discover
unregistered children left by an older OpenClaw version or scan command names
to infer ownership. Windows does not yet have equivalent orphan registration
and recovery.
