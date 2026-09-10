---
summary: "Experimental native sandbox execution streaming and node-backed remote exec"
read_when:
  - You are enabling the experimental sandbox exec-server
  - You are running Codex native execution on a paired node
title: "Codex sandbox process streaming"
sidebarTitle: "Sandbox streaming"
---

Opt-in streaming for sandboxed native execution, and how node-backed remote exec differs from it. Part of the [Codex harness runtime](/plugins/codex-harness-runtime) guide; [Where each section moved](/plugins/codex-harness-runtime#where-each-section-moved) lists every section.

## Experimental sandbox process streaming

Native sandbox execution remains opt-in through
`appServer.experimental.sandboxExecServer`. When enabled for an active
OpenClaw sandbox, sandboxed processes stream ordered stdout, stderr, or PTY
output notifications. OpenClaw retains only a bounded recent-output buffer for
polling and replay, so long-running processes cannot grow the app-server bridge
without limit. Process exit and cleanup remain tied to the sandbox-owned
process. Failed environment registration never falls back to host execution.

See [Sandboxed native execution](/plugins/codex-harness-reference#sandboxed-native-execution)
for configuration and local-only transport restrictions.

Node-backed `remote-exec`, whether on a paired device or the same Crabbox cloud
profile used for OpenClaw worker turns, is separate from the experimental
local sandbox flag. Codex app-server and model auth stay on the Gateway, while
an explicitly authorized managed exec-server on the enrolled node owns
process, filesystem, capability, and credential-free HTTP operations. The
Gateway rejects authentication, cookie, API-key, and other sensitive HTTP
headers before they reach the node; authenticated HTTP must run on the
Gateway. The existing duplex node channel carries the Codex JSON-RPC stream
without starting an OpenClaw worker child or consuming a worker slot. Explicit
Gateway command allowlisting remains required. Launch needs per-attempt
allow-once approval or exact admitted session Full access with node-local
full/off policy. Full access never overrides local deny, ask, or allowlist
restrictions, pairing, hosting consent, command authorization, or tool policy.
The node rechecks local policy immediately before spawning the pinned binary;
a stale launch is refused. Each attempt owns an isolated Gateway app-server client so its
remote environment registration retires with that attempt. Disconnect ends the
active attempt and its remote processes; reconnect allows only a fresh
attempt. Normal Codex turns work, but `/btw` side questions fail closed because
they are not yet placement-bound. The placement workspace does not confine
execution: process and filesystem access remain bounded only by the node's
operating system account.
