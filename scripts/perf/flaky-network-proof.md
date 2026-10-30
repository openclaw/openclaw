# Real-Gateway flaky network proof

This opt-in diagnostic checks Control UI recovery on an airplane-grade link against a
**new loopback Gateway** started from a built `dist/entry.js`. It is not part of CI.
It reuses the [warm reload proof](warm-reload-proof.md) owners: the synthetic
Team-shaped fixture, the QA Lab mock OpenAI provider, and the signed-in
trusted-proxy admission. It never accepts a live URL, copies operator state, or
reads credentials.

Chromium talks to a TCP fault proxy, which is the browser-visible origin. The proxy
forwards to the admission proxy, which forwards to the Gateway:

```text
Chromium -> flaky-network-proxy (public origin) -> admission (cookie -> trusted proxy) -> Gateway
```

Faults act on the byte stream, so HTTP, service-worker fetches, and WebSockets share one
simulated link. The OS stays online, as on cabin Wi-Fi, so `navigator.onLine` never helps.

## Run

Build the revision under test, then run from the repository root:

```sh
pnpm build
node --import ./scripts/tsx.mjs scripts/perf/flaky-network-proof.ts --dist dist
```

`--ui-root <dir>` serves another built Control UI against the same Gateway.
`--scenarios blackout,offline-reload,queue-reload` selects scenarios (default: all),
`--blackout-seconds 45` sets the silent outage length, and `--sessions 2000` sizes the
fixture. All listeners bind `127.0.0.1` on free ports in **19600–19699**. State lives in
a fresh child of `--output` (default `.local/flaky-network-proof`), which must be inside
this worktree's `.local/`. The tool stops its browser, proxies, mock provider, and
Gateway on completion, failure, or Ctrl-C. Without a TTY the launcher re-execs the
Gateway in its own process group, so the tool also stops whatever Gateway still listens
on its port. Keep the shell alive until cleanup completes.

The browser first loads the chat route on an unshaped link, waits for the service
worker and transcript, and lets the cache owners persist for four seconds. Each
scenario then switches to the airplane profile and waits for a connected Gateway.

## Link profile

GEO-satellite cabin Wi-Fi as measured for openclaw/openclaw#186325: **700 ms** added
RTT, **0–150 ms** per-chunk jitter, **190 KB/s** down and **50 KB/s** up, shared by all
flows. Faults:

- **blackhole**: bytes vanish silently. Flows that carried bytes during it stay dead
  afterwards with no FIN or RST, like lost NAT state; new connections are accepted and
  then hang.
- **refuse**: new connections are reset; together with a reset of every live flow this
  models no route or a captive portal.

## Scenarios and thresholds

Limits sit between the base and fixed measurements of openclaw/openclaw#186325 and
openclaw/openclaw#186316, with headroom for jitter. A visible connection status is
either the shell status pill or the chat pane header status ("Saved conversation ·
Reconnecting…" during a warm boot). Restore → connected ends at the first Gateway
handshake (`hello-ok`) on any WebSocket after the link returns, so a page that never
noticed the outage cannot pass by still showing "connected".

**`blackout`** blackholes the link, sends a message after 3 s into the still-open
socket, and restores after `--blackout-seconds`. The 45-second default leaves a hung
opening attempt at restore both on current main and on a client without
openclaw/openclaw#186325. Precondition: an unopened WebSocket exists at restore.
Checks: send → visible connection status ≤ 22 s; restore → connected ≤ 10 s; the
message is delivered exactly once.

**`offline-reload`** refuses new connections, resets live ones, reloads, and restores
after 15 s. Checks: cached transcript rows ≤ 3 s after reload; visible connection
status ≤ 10 s; every composer placeholder names the cached agent; restore → connected
≤ 10 s.

**`queue-reload`** refuses and resets, sends a message (it queues), reloads while still
offline, and restores after 8 s. Precondition: the send was queued. Checks: restore →
connected ≤ 10 s; the message appears exactly once in the Gateway transcript and in
the visible transcript.

Delivery checks poll the Gateway transcript (`chat.history` through the built CLI) for
up to 60 seconds after restore, then observe ten more seconds so a duplicate delivery
would be counted. The visible count reads the active pane's message text; an
optimistic bubble alone never proves delivery.

A scenario is `fail` when any threshold check fails, `invalid` when every check passed
but a precondition did not hold (the pass would be vacuous), and `pass` otherwise. The
tool exits nonzero unless every selected scenario passes.

## Output

Each run directory contains:

- `summary.json`: revision, build paths, profile, thresholds, and per-scenario checks
  with values, limits, verdicts, and proxy byte deltas.
- `events.json`: one clock for runner notes (network changes, sends, reloads), every
  WebSocket creation/open/close, and each change of gateway phase, visible shell pill
  and label, chat pane status, transcript row count, queued sends, and composer
  placeholder.
- `timeline.txt`: the same events per scenario, relative to the scenario start, with
  only changed UI fields.
- `<scenario>-during.png`, `<scenario>-after.png`, `gateway.log`, and the seeded
  `state/`.

## Limits

Timings on a busy development Mac are diagnostic; rerun before treating one failed
timing check as a regression. Faults model loss and resets at TCP flow level, not
packet reordering or TLS. Probe entries from a document are collected before every
navigation; anything logged in the last moment before unload can be missed. New
scenarios should come with an explicit threshold or precondition rather than an
unchecked timeline.
