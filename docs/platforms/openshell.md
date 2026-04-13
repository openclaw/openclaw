---
summary: "Deploy OpenClaw inside an NVIDIA OpenShell sandbox — proxy egress, network policy, Go/Node TLS, launcher pattern"
read_when:
  - You want to run OpenClaw inside an OpenShell sandbox
  - You need HTTP CONNECT proxy-only egress with auditable policy
  - You hit DNS, TLS, WebSocket, or media-generation errors in a sandboxed agent
title: "OpenShell Sandbox"
sidebarTitle: "OpenShell"
---

# OpenClaw on OpenShell

Run OpenClaw inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox when you want network isolation, filesystem sandboxing, and a
policy-controlled egress path. The sandbox runs under K3s inside a Docker
container and routes every outbound connection through an L7 HTTP CONNECT
proxy — UDP DNS from inside the sandbox is blocked by design.

This guide covers the operational shape that actually works in production: a
local (per-sandbox) OpenClaw install, a launcher script that exports the
environment before the gateway process starts, and the small set of patches
required because some OpenClaw code paths still assume direct network egress.

**Why OpenShell?**

- Every outbound connection is matched against a YAML policy keyed on the
  `(binary, host, port)` tuple, with `audit` and `enforce` modes.
- Filesystem is split into read-only and read/write trees. `/usr` and `/lib`
  are read-only, so `sudo` does not help you install software at runtime.
- Policy is hot-reloadable: edit the YAML, run `openshell policy set`, no
  sandbox restart.
- Well suited to long-running agents holding API keys — the blast radius of
  a misbehaving tool is contained.

**When to prefer running OpenClaw directly (not in a sandbox):**

- The host is already trusted and you want direct DNS + egress.
- You need raw UDP, ICMP, or anything the CONNECT proxy cannot tunnel.
- You want the Mac companion app; the companion app runs on the host, not
  inside OpenShell.

## Prerequisites

| Requirement   | Version  | Notes                                                                                 |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| OpenShell CLI | 0.0.25+  | `openshell --version`                                                                 |
| Docker        | 24+      | Required by OpenShell's K3s cluster container                                         |
| Node.js       | 22.16+   | Required inside the sandbox (bundled in OpenShell's OpenClaw base image)              |
| A proxy CA    | PEM file | The sandbox proxy performs TLS interception; Go binaries need this in `SSL_CERT_FILE` |

<Note>
OpenShell v0.0.26 rejects TLD-level wildcards like `*.com` in policy YAML.
If you are on v0.0.26+, list concrete subdomains (for example
`*.reuters.com`) instead. Mixed versions across a single cluster are fine.
</Note>

## Deployment shape

```
Host
 └── OpenShell cluster container  (docker, exposes https://127.0.0.1:8080)
      └── K3s pod: "agent" sandbox
           ├── /sandbox/node_modules/openclaw/     ← local OpenClaw install
           ├── /sandbox/.openclaw/openclaw.json    ← config, auth, LCM, memory
           ├── /sandbox/start-gateway.sh           ← launcher (exports env, starts gateway)
           └── /sandbox/openclaw-ws-proxy-patch.js ← NODE_OPTIONS --require bootstrap
```

Every file that matters — bundle, config, launcher, patches, logs —
lives under `/sandbox`. That directory is preserved across gateway restarts
but destroyed when the sandbox itself is recreated, so treat it as
pet-not-cattle and keep a snapshot before upgrades.

## Install OpenClaw inside a sandbox

Inside an OpenShell sandbox, the host's systemd unit and global `npm -g`
directory are not available. Install OpenClaw as a **local** dependency
under `/sandbox`, then symlink the entry point onto the sandbox `PATH`.

```bash
# From the host
openshell sandbox create --name agent \
  --policy ~/openshell-policy.yaml \
  --forward 18789
```

Then, inside the sandbox:

```bash
cd /sandbox
npm install openclaw@<target-version> --no-audit --no-fund
ln -sf /sandbox/node_modules/openclaw/openclaw.mjs /sandbox/.local/bin/openclaw
openclaw --version
```

Notes:

- **Do not use `sudo`** inside the sandbox. `/usr/lib` is read-only and
  `sudo` will either fail or leave the install in an inconsistent state.
- **Do not use `npm install -g`.** There is no global prefix you can write
  to. A local `node_modules` install is the only supported path.
- **Pin the version.** Upgrades are cheap (see below), but surprise upgrades
  during a `docker restart` are not.

## The launcher pattern (and the `.bashrc` trap)

The single most common failure mode we see on new deployments is
"everything works when I SSH in and run `openclaw gateway run` by hand, but
breaks when I launch the gateway as a background process." The cause is
always the same: environment variables are only being set by an interactive
shell.

`.bashrc` is sourced by interactive SSH sessions. The gateway process,
launched from a script or by a restart, does **not** source `.bashrc`. Any
environment variable your tools rely on — proxy configuration, TLS CA
bundle, API keys, keyring passwords — must be exported by the launcher
itself, before it execs the gateway.

Use this shape for the launcher:

```bash
#!/usr/bin/env bash
# /sandbox/start-gateway.sh
set -euo pipefail

# 1. Proxy (the sandbox injects this via OpenShell's network namespace,
#    but we re-export it explicitly so child processes see it).
export HTTP_PROXY="http://10.200.0.1:3128"
export HTTPS_PROXY="http://10.200.0.1:3128"
export NO_PROXY="localhost,127.0.0.1,10.0.0.0/8"

# 2. TLS CA bundle — used by Go binaries and any tool that does not read
#    the Node / OpenSSL cert store. See "TLS for Go binaries" below.
#    Regenerated on every launcher run because /tmp is ephemeral across
#    sandbox/pod restarts; without this rebuild, Go tools fail with
#    `x509: certificate signed by unknown authority` after a reboot.
if [ -f /etc/ssl/certs/ca-certificates.crt ] && [ -f /opt/openshell/ca.pem ]; then
  cat /etc/ssl/certs/ca-certificates.crt /opt/openshell/ca.pem > /tmp/combined-ca.pem
fi
export SSL_CERT_FILE="/tmp/combined-ca.pem"

# 3. Node preload for the WebSocket proxy patch (see "WebSocket proxy" below).
export NODE_OPTIONS="--require /sandbox/openclaw-ws-proxy-patch.js"

# 4. Any tool-specific secrets your sandboxed agent needs at runtime.
#    Do NOT commit these — read from a file you control outside the sandbox
#    or inject at sandbox-create time.
export BOT_TOKEN="<your-bot-token>"
export API_KEY="<your-api-key>"

# 5. Self-heal local patches that are wiped by `npm install` (see below).
bash /sandbox/heal-fetch-guard.sh || true

# 6. Start the gateway in the foreground so the sandbox supervisor owns its
#    lifecycle. For background use, redirect to a logfile and write a pidfile.
exec /sandbox/node_modules/openclaw/openclaw.mjs gateway run --allow-unconfigured
```

Call this script from `openshell sandbox exec` or from a supervisor inside
the sandbox — never rely on `.bashrc` to paper over missing env vars.

## TLS for Go binaries (`SSL_CERT_FILE`)

The OpenShell proxy performs TLS interception, so every egressing TLS
connection terminates at a proxy-signed certificate. Node.js and
OpenSSL-based tools usually pick up the system store automatically. **Go
binaries do not.**

```bash
# Combine the system store with the OpenShell CA bundle
cat /etc/ssl/certs/ca-certificates.crt /opt/openshell/ca.pem > /tmp/combined-ca.pem
export SSL_CERT_FILE="/tmp/combined-ca.pem"
```

`/tmp` is intentionally ephemeral in an OpenShell sandbox, so the bundle
is regenerated by `start-gateway.sh` on every launcher run (see step 2
above). If you prefer a persistent location, write to
`/sandbox/combined-ca.pem` instead — but note that any change to the
underlying OpenShell CA (e.g. after a cluster cert rotation) will then
require a manual rebuild, whereas the launcher-regenerated form
self-heals automatically on restart.

If you add a Go binary to the sandbox and it fails with
`x509: certificate signed by unknown authority`, this is the fix — and it
must be set in the launcher, not only in `.bashrc`.

Python's `requests` respects `REQUESTS_CA_BUNDLE`, and curl respects
`CURL_CA_BUNDLE`. Set all three if you run a mixed toolchain.

## Network policy

The sandbox routes all traffic through an HTTPS CONNECT proxy at
`10.200.0.1:3128` by default. A YAML policy file controls which binaries
can reach which hosts and ports.

### Policy structure

```yaml
version: 1

filesystem_policy:
  read_only: [/usr, /lib, /etc, /opt]
  read_write: [/sandbox, /tmp]

# Reusable binary list — referenced via YAML anchor so every network rule
# accepts the same set of executables.
binaries: &binaries
  - { path: /usr/bin/node }
  - { path: /sandbox/.local/bin/openclaw }

network_policies:
  llm_providers:
    endpoints:
      - { host: api.openai.com, port: 443, enforcement: enforce }
      - { host: api.anthropic.com, port: 443, enforcement: enforce }
      - { host: api.example.com, port: 443, enforcement: enforce }
    binaries: *binaries

  slack_rest:
    endpoints:
      - { host: slack.com, port: 443, enforcement: enforce }
      - { host: api.slack.com, port: 443, enforcement: enforce }
      - { host: files.slack.com, port: 443, enforcement: enforce }
      - { host: hooks.slack.com, port: 443, enforcement: enforce }
      - { host: edgeapi.slack.com, port: 443, enforcement: enforce }
    binaries: *binaries

  slack_websocket:
    endpoints:
      # Raw TCP passthrough — do NOT let the L7 proxy intercept the upgrade.
      - { host: wss-primary.slack.com, port: 443, tls: skip, enforcement: enforce }
      - { host: wss-backup.slack.com, port: 443, tls: skip, enforcement: enforce }
    binaries: *binaries
```

Key rules:

- **Every network policy section must list its binaries.** Without a
  `binaries` entry the proxy cannot identify the process and will deny all
  CONNECT requests from that binary, even if the host is otherwise allowed.
- **Policy is hot-reloadable.** After editing the YAML, run
  `openshell policy set <sandbox-name> --policy <path>`. No sandbox
  restart required.
- **Each network-capable binary must appear in a `binaries` list
  somewhere.** When you add a new CLI tool (Go, Python, Node, shell script)
  that makes outbound requests, add its path to the shared binary anchor
  and reload the policy.

### Slack REST vs WebSocket split

Slack uses separate hosts for its REST API and its Socket Mode WebSocket.
They must be split into separate policy sections because the WebSocket
endpoints need `tls: skip` — the L7 proxy will otherwise intercept the
upgrade handshake and break the Socket Mode frame stream.

| Traffic   | Hosts                                                                                   | Policy section    |
| --------- | --------------------------------------------------------------------------------------- | ----------------- |
| REST API  | `slack.com`, `api.slack.com`, `files.slack.com`, `hooks.slack.com`, `edgeapi.slack.com` | `slack_rest`      |
| WebSocket | `wss-primary.slack.com`, `wss-backup.slack.com`                                         | `slack_websocket` |

<Warning>
Do **not** use `*.slack.com` as a wildcard. On OpenShell 0.0.15+, a
wildcard `slack.com` policy silently overrides the `slack_websocket`
entry and breaks Socket Mode. List each Slack host individually.
</Warning>

<Warning>
On OpenShell v0.0.26+, TLD-level wildcards such as `*.com` or `*.org` are
rejected at policy load. Replace with concrete subdomain wildcards
(`*.reuters.com`, `*.openai.com`) or explicit host lists.
</Warning>

### Slack file uploads

If your agent uploads files to Slack (images, audio, PDFs), you will also
need `*.slack-edge.com` and `*.slack-files.com` in the REST policy section.
The upload URL resolution flow hits all three domains in sequence, and a
missing one produces a confusing "dispatcher not allowed" error deep in
the undici stack.

## WebSocket proxy patch

The `ws` library, used by Slack's `@slack/socket-mode` and by
`discord.js`, does not honor the `HTTPS_PROXY` environment variable. In a
sandbox where every byte has to traverse the CONNECT proxy, the default
direct-connection behavior always fails.

The fix is a small Node preload script that installs a global undici
`EnvHttpProxyAgent` and wraps the `ws` constructor to tunnel through the
proxy. Attach it via `NODE_OPTIONS`:

```bash
export NODE_OPTIONS="--require /sandbox/openclaw-ws-proxy-patch.js"
```

The preload should:

1. Read `HTTPS_PROXY` from the environment.
2. Install `new EnvHttpProxyAgent()` as the undici global dispatcher
   (`setGlobalDispatcher`), so every `fetch()` call in OpenClaw uses it
   without further configuration.
3. Monkey-patch `Module._load` so that when any code requires `ws`, the
   returned constructor injects a CONNECT-tunneled `https.Agent` for the
   configured Slack / Discord hosts.
4. Log a one-line banner on startup so you can confirm it activated.

At gateway startup you should see three lines:

```
[ws-proxy-patch] global dispatcher → EnvHttpProxyAgent (http://10.200.0.1:3128)
[ws-proxy-patch] wrapping wss://wss-primary.slack.com through proxy
[slack] socket mode connected
```

If you see the third line, Slack is live end-to-end.

## Media-generation SSRF fetch guard

OpenClaw routes image, music, video, and audio generation providers
through a strict fetch guard (`fetchWithSsrFGuard`). In its default mode,
this guard does a pinned DNS lookup **before** making the HTTP request —
which cannot succeed in a sandbox where UDP DNS is blocked and all traffic
must go through a CONNECT proxy. LLM chat paths work because they use the
global undici dispatcher installed by the WebSocket proxy patch; media
generation bypasses that and tries to pin DNS itself.

The tracking issue is
[openclaw/openclaw#52162](https://github.com/openclaw/openclaw/issues/52162).
Until it is fixed upstream, a two-line local patch on the fetch-guard
bundle lets media generation reach the proxy the same way chat does.

The semantic patch, applied to `dist/fetch-guard-*.js`:

```diff
- if (mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured())
-     dispatcher = createHttp1EnvHttpProxyAgent();
+ if (hasProxyEnvConfigured()) { /* PATCHED: skip DNS pinning in proxy env */ }
```

The empty-block form is deliberate: `dispatcher` stays `null`, the `init`
object does not include a `dispatcher` key, and `defaultFetch` falls
through to the global undici dispatcher already set up by the proxy
preload. Same mechanism chat uses.

Because the bundle filename includes a content hash and changes every
release, the patch is wiped by `npm install` on each upgrade. Put the
heal in the launcher so it runs on every start:

```bash
# /sandbox/heal-fetch-guard.sh
FETCH_GUARD=$(ls /sandbox/node_modules/openclaw/dist/fetch-guard-*.js 2>/dev/null | head -1)
if [ -n "$FETCH_GUARD" ] && ! grep -q "PATCHED" "$FETCH_GUARD"; then
  sed -i \
    's|if (mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured()) dispatcher = createHttp1EnvHttpProxyAgent();|if (hasProxyEnvConfigured()) { /* PATCHED: skip DNS pinning in proxy env */ }|' \
    "$FETCH_GUARD"
  if grep -q "PATCHED" "$FETCH_GUARD"; then
    echo "[heal] Re-applied fetch-guard patch to $(basename "$FETCH_GUARD")"
  else
    echo "[heal] WARNING: fetch-guard pattern did not match in $(basename "$FETCH_GUARD") — upstream bundle format likely changed; update the sed expression" >&2
    exit 1
  fi
fi
```

Idempotent (checks the marker before applying), version-resilient
(filename glob, not literal), and safe to run on every start. The
post-`sed` re-grep is load-bearing: after an upstream bundle rewrite the
original pattern can silently fail to match, and without the verification
gate the launcher would print "Re-applied" while the DNS-pinning code is
still live — media generation would then keep failing in proxy-only
sandboxes. The launcher fails fast instead, so operators notice the
drift on the next restart. Remove it
once the upstream issue is fixed and you have rolled through a release
that includes the fix.

## Upgrading OpenClaw inside a sandbox

A sandbox upgrade is a local `npm install`, not a systemd dance. There is
no global install to replace and no service to restart — just stop the
gateway, reinstall, and restart.

```bash
# 1. Snapshot before upgrade (rollback path)
openshell sandbox exec --name agent -- sh -lc \
  'mkdir -p /tmp/snap && cd /sandbox && tar czf /tmp/snap/pre-upgrade-$(date -u +%Y%m%d-%H%M%S).tar.gz \
     node_modules/openclaw .openclaw/openclaw.json start-gateway.sh openclaw-ws-proxy-patch.js'

# 2. Stop the gateway cleanly
openshell sandbox exec --name agent -- sh -lc \
  'pkill -f "openclaw.*gateway"; sleep 2; ps -ef | grep openclaw | grep -v grep'

# 3. Install the target version
openshell sandbox exec --name agent -- sh -lc \
  'cd /sandbox && npm install openclaw@<version> --no-audit --no-fund'

# 4. Verify version and bundle hash
openshell sandbox exec --name agent -- sh -lc \
  'openclaw --version; ls /sandbox/node_modules/openclaw/dist/server.impl-*.js'

# 5. Start the gateway (launcher reapplies local patches automatically)
openshell sandbox exec --name agent -- sh -lc 'bash /sandbox/start-gateway.sh'
```

Rollback is the inverse of step 3:

```bash
openshell sandbox exec --name agent -- sh -lc \
  'pkill -f "openclaw.*gateway"; sleep 2; \
   cd /sandbox && rm -rf node_modules/openclaw && \
   tar xzf /tmp/snap/<snapshot>.tar.gz node_modules/openclaw && \
   bash /sandbox/start-gateway.sh'
```

A canonical smoke test after every upgrade:

1. `openclaw --version`
2. `openclaw status` — sessions, model chain, channel plugins loaded
3. `openclaw sessions` — list recent sessions
4. End-to-end channel test (Slack DM, Discord DM, or whatever channel the
   agent is on) — ensures the Socket Mode patch still works
5. If image gen is in use, generate a tiny test image — verifies the
   fetch-guard heal fired on startup

## Troubleshooting

### `openshell sandbox upload` wraps single files in a directory

This bites every new operator exactly once. `openshell sandbox upload`
treats the target path as a destination directory and places the source
file inside it. For single files, use `scp` via the forwarded port
(`scp openshell-agent:/path ...`) or unwrap manually after the upload.

### DNS / `EAI_AGAIN` errors at gateway start

The sandbox has no UDP DNS. Every name resolution happens at the CONNECT
proxy, which resolves the hostname itself. If you see `EAI_AGAIN`, you
are looking at code that is calling `dns.lookup` directly (usually the
fetch guard or a custom tool). Confirm with a **proxied request** — not
`getent`. `getent hosts` queries the sandbox's local resolver and does
not traverse the HTTP CONNECT path, so it can fail even when proxied
application traffic is perfectly healthy (and send you toward the wrong
fix):

```bash
# Real proxy-path reachability check: terminate at the proxy, resolve via
# the proxy's DNS view. HTTP 200/301/401/403 all count as success — any
# response from the origin means the proxy routed the request.
openshell sandbox exec --name agent -- sh -lc \
  'curl -sS -o /dev/null -w "%{http_code}\n" -m 10 \
     -x "$HTTPS_PROXY" https://api.openai.com/'
```

If the command prints `000` or hangs, the proxy cannot reach the
hostname from its egress view — add it to the network policy, not to
`/etc/hosts`.

### Gateway starts, Slack never says "connected"

Check in order:

1. `NODE_OPTIONS` includes the WebSocket proxy preload (see launcher).
2. Policy has `slack_websocket` with `tls: skip` for both
   `wss-primary.slack.com` and `wss-backup.slack.com`.
3. No wildcard `slack.com` or `*.slack.com` entry is masking the
   WebSocket section.
4. Slack app events, scopes, and App Home are configured, and the app was
   **reinstalled** after any change to scopes or events.

### Gateway starts, image generation fails

Almost always the fetch-guard patch is missing or was wiped by an upgrade.
Verify:

```bash
openshell sandbox exec --name agent -- sh -lc \
  'grep -c PATCHED /sandbox/node_modules/openclaw/dist/fetch-guard-*.js'
```

Expect `1`. If it is `0`, your launcher's heal block did not run — check
the launcher path and ordering.

### Gateway environment is missing a variable your CLI tool needs

This is the `.bashrc` trap. Move the export into the launcher script, then
restart the gateway. See [The launcher pattern](#the-launcher-pattern-and-the-bashrc-trap).

### `openclaw doctor` suggests `doctor --fix`

**Do not run `openclaw doctor --fix`** on a configured sandbox. It has a
history of nullifying channel configurations (Telegram, WhatsApp) and
triggering spurious restart loops under load. The tracking issues are
[#64194](https://github.com/openclaw/openclaw/issues/64194) and
[#64400](https://github.com/openclaw/openclaw/issues/64400). Use
`openclaw status` plus the plugin-specific CLI commands for diagnostics
instead.

### `sudo npm install -g openclaw@latest` on the host leaves systemd on the old entrypoint

This is a host-install footgun rather than a sandbox issue, but it comes
up enough to be worth flagging:
[#64014](https://github.com/openclaw/openclaw/issues/64014). If you are
running the gateway on the host under systemd, verify the unit's
`ExecStart` after every global upgrade.

### Policy set rejects TLD wildcards

You are on OpenShell v0.0.26+. Replace `*.com` style rules with concrete
subdomain wildcards or explicit hostname lists. See the warning above
under [Network policy](#network-policy).

## Resilience after host reboot

After a host power cycle or Docker daemon restart, K3s brings the sandbox
pods back to `Ready` on its own — but the gateway process inside each
sandbox does **not** auto-start on OpenShell v0.0.25. Native boot hooks
are tracked in [NVIDIA/OpenShell#775](https://github.com/NVIDIA/OpenShell/pull/775)
and land in a later release; until you are on a version that includes
them, the fleet needs a host-side recovery path.

### Failure modes you will actually see

- **Sandbox pods `Ready`, gateways silent.** `openshell sandbox list` shows
  every pod healthy, but `curl` against the forwarded port returns nothing
  because the gateway inside never started.
- **`openshell forward list` state desync.** The local state tracker can
  show a stale `dead` entry for a sandbox whose pod has since been
  respawned, or drop the entry entirely while the underlying tunnel is
  gone. Treat `forward list` output as a hint, not ground truth, across a
  reboot. (Worth filing upstream as a separate issue — the tracker should
  reconcile against the live pod set on startup.)
- **Orphan SSH tunnels holding the forward port.** An SSH tunnel from
  before the power cycle can still be bound to the local forward port
  long after the pod it served is gone. A fresh `openshell forward start`
  then fails silently because the port is already in use. The symptom is
  "forward start returns 0 but nothing is listening" — the giveaway is
  that `ss -tln` still shows the port bound to a PID that no longer
  belongs to openshell.

### Manual recovery

The diagnostic flow is always the same: verify the pod, verify the
forward, verify the gateway process, fix whichever layer is broken.

```bash
# 1. Is the sandbox pod itself up?
openshell sandbox list

# 2. What does openshell think about the forward?
openshell forward list

# 3. Is anything else holding the forward port?
ss -tln | grep <port>

# 4. If ss shows an orphan SSH tunnel, kill it before restarting the forward
kill <pid>

# 5. Is the gateway process actually running inside the sandbox?
#    Matches both `openclaw-gateway` (legacy entrypoint) and the current
#    `node .../openclaw.mjs gateway run` form spawned by the launcher.
openshell sandbox exec --name <sandbox> -- sh -lc 'pgrep -af "openclaw(-gateway|.*gateway run)"'

# 6. If the gateway is missing, launch it via the sandbox's start script
openshell sandbox exec --name <sandbox> -- sh -lc \
  'nohup bash /sandbox/<your-start-script.sh> > /tmp/start.log 2>&1 &'

# 7. Reset the forward cleanly (stop first in case of a stale entry)
openshell forward stop <port> <sandbox> || true
openshell forward start <port> <sandbox> --background

# 8. Verify end to end
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/health
```

A successful recovery prints `200` on the final curl. Anything else means
one of the earlier steps was skipped or the gateway crashed again — check
the start script log at `/tmp/start.log`.

### Automated recovery with a host-side watchdog

Driving that flow by hand after every reboot is not a plan. A small
systemd **user** timer that runs a health-and-heal script every 60s keeps
the fleet self-healing until native boot hooks land.

The pattern has three pieces: the script, a oneshot service, and a timer
that triggers the service.

#### The watchdog script

Place at `${HOME}/.local/bin/openshell-fleet-watchdog.sh` and make it
executable (`chmod +x`).

```bash
#!/bin/bash
# openshell-fleet-watchdog.sh — health-check + self-heal the sandbox fleet.
#
# Why this exists: on OpenShell v0.0.25, sandbox pods come back Ready after
# a host power cycle but the gateway process inside does NOT auto-start.
# NVIDIA/OpenShell#775 adds native sandbox boot hooks in a later release;
# retire this watchdog once you are on a version that includes it.
#
# Each loop iteration:
#   1. Fast path: curl the forwarded /health. If 200, done — no logs.
#   2. Slow path: check the gateway process inside the sandbox; launch via
#      the sandbox's start script if missing.
#   3. Stop + restart the port forward (the state tracker desyncs across
#      power cycles, leaving stale dead entries).
#   4. Verify /health through the forward. Log only on recovery events.

set -u
export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"

LOG_FILE="${HOME}/.local/state/openshell-fleet-watchdog.log"
mkdir -p "$(dirname "$LOG_FILE")"

# Fill this in for your fleet. Format: "<sandbox>:<port>:<launcher-name.sh>"
# The launcher is the path under /sandbox that exports env vars and execs
# the gateway (see "The launcher pattern" above).
FLEET=(
  "agent-a:8080:start-gateway.sh"
  "agent-b:8081:start-gateway.sh"
)

log() {
  echo "[$(date -uIs)] watchdog: $*" >> "$LOG_FILE"
}

check_sandbox() {
  local name="$1"
  local port="$2"
  local launcher="$3"

  # Fast path — happy case is silent.
  if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${port}/health"; then
    return 0
  fi

  log "${name} /health failed on :${port}, starting recovery"

  # Match both the legacy `openclaw-gateway` entrypoint and the current
  # `node .../openclaw.mjs gateway run` form spawned by the launcher. Using
  # the narrower `openclaw-gateway` regex here would return false on the
  # `gateway run` form even when the process is healthy, causing the
  # watchdog to needlessly relaunch and fight port conflicts.
  if ! openshell sandbox exec --name "$name" -- sh -lc 'pgrep -f "openclaw(-gateway|.*gateway run)" > /dev/null' 2>/dev/null; then
    log "${name} gateway process missing, launching ${launcher}"
    openshell sandbox exec --name "$name" -- sh -lc \
      "nohup bash /sandbox/${launcher} > /tmp/watchdog-start.log 2>&1 &" \
      >/dev/null 2>&1
    sleep 5
  else
    log "${name} gateway process alive, forward layer likely stale"
  fi

  openshell forward stop "$port" "$name" >/dev/null 2>&1 || true
  sleep 1
  if ! openshell forward start "$port" "$name" --background >/dev/null 2>&1; then
    log "${name} forward start failed"
    return 1
  fi
  sleep 3

  if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${port}/health"; then
    log "${name} recovered"
    return 0
  else
    log "${name} RECOVERY FAILED (gateway not responding on :${port} after restart)"
    return 1
  fi
}

rc=0
for entry in "${FLEET[@]}"; do
  IFS=: read -r name port launcher <<< "$entry"
  check_sandbox "$name" "$port" "$launcher" || rc=1
done
exit $rc
```

A couple of design choices worth calling out:

- The happy path is **silent**. Logging on every successful check fills
  the log with noise that hides the one line you actually care about.
- Recovery is **layered**: the cheapest fix (kick the forward) runs even
  when the gateway process is alive, because the `forward list` desync is
  the more common failure.
- The log lives under `${HOME}/.local/state/` so it survives reboots but
  does not pollute `/tmp`.

#### The systemd user units

Save as `${HOME}/.config/systemd/user/openshell-fleet-watchdog.service`:

```ini
[Unit]
Description=OpenShell fleet watchdog (health-check and self-heal sandboxes)

[Service]
Type=oneshot
ExecStart=%h/.local/bin/openshell-fleet-watchdog.sh
Nice=10
```

And as `${HOME}/.config/systemd/user/openshell-fleet-watchdog.timer`:

```ini
[Unit]
Description=Run the OpenShell fleet watchdog every 60 seconds

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=openshell-fleet-watchdog.service

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now openshell-fleet-watchdog.timer
systemctl --user list-timers openshell-fleet-watchdog.timer
```

If you want the timer to run even when you are not logged in, enable
lingering for the user with `loginctl enable-linger <user>`.

### Upgrade path

This host-side watchdog is a v0.0.25-era substitute for native sandbox
boot hooks. [NVIDIA/OpenShell#775](https://github.com/NVIDIA/OpenShell/pull/775)
adds sandbox boot hooks in a future release; once you are on a version
that includes it, you can replace this watchdog with an in-sandbox boot
hook that launches the gateway's start script directly on pod start, and
retire the host-side timer entirely.

## Advanced: swapping the OpenShell supervisor binary

When you are testing a custom OpenShell supervisor (for example to
validate a policy change or an unreleased PR), you can replace the
supervisor binary inside the cluster container without destroying
sandboxes:

```bash
# 1. Remove the stock binary ("text file busy" otherwise)
docker exec openshell-cluster-openshell rm /opt/openshell/bin/openshell-sandbox

# 2. Copy the new binary in
docker cp ./openshell-sandbox openshell-cluster-openshell:/opt/openshell/bin/openshell-sandbox

# 3. Kill the running supervisor — K3s respawns the sandbox pod in ~15s
docker exec openshell-cluster-openshell sh -c \
  'kill -9 $(pgrep -f openshell-sandbox)'
```

<Warning>
K3s respawns the **sandbox pod**, not the OpenClaw gateway process
running inside it. After the respawn, manually restart the gateway:

```bash
openshell sandbox exec --name agent -- sh -lc 'bash /sandbox/start-gateway.sh'
```

Until you do, the sandbox is up but the gateway is dead.
</Warning>

Keep a copy of the stock binary inside the container so you can roll back
without re-pulling the image:

```bash
docker exec openshell-cluster-openshell \
  cp /opt/openshell/bin/openshell-sandbox /tmp/openshell-sandbox.stock
```

## Related

- [OpenShell plugin configuration](/gateway/openshell) — using OpenShell
  as a managed sandbox backend from host OpenClaw
- [Sandboxing overview](/gateway/sandboxing) — OpenClaw's sandboxing
  model and trust boundaries
- [Slack channel setup](/channels/slack) — Slack app, scopes, manifest
- [Network model](/gateway/network-model) — gateway networking primitives
