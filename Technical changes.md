OpenClaw – Non-Standard Deployment Notes \& Deviations

This document records all technical deviations from a “default / assumed” OpenClaw setup that were required to make a stable, production Docker deployment behind Traefik + Cloudflare.

If you are re-deploying, upgrading, or debugging in the future:
read this first to avoid repeating the same dead ends.



1. Summary (TL;DR)

This deployment intentionally deviates from a naïve OpenClaw setup in order to:

Run cleanly inside Docker

Avoid systemd assumptions

Work behind reverse proxies

Support Traefik + Cloudflare

Be reproducible and debuggable

The single most important change is:

OpenClaw must be run in foreground “gateway” mode, NOT as a service/daemon.

2. What “Standard” Setup Assumes (and Why It Failed)

Upstream OpenClaw tooling implicitly assumes:

A user systemd environment

A local desktop or VM

Direct localhost access

No reverse proxy

Direct browser → gateway connection

In Docker, all of those assumptions are false.

This caused:

restart loops

systemctl --user unavailable

“connection refused”

unstable pairing

unknown requestId

blocked skills

misleading error messages

3. Explicit Deviations (Do Not Undo These)
   3.1 Do NOT use service / daemon / systemd modes

❌ DO NOT USE

openclaw gateway start
openclaw daemon
openclaw service



These attempt:

systemctl --user

service health checks

background process management

They will fail in Docker.

✅ Correct approach (required)

node /app/openclaw.mjs gateway --port 18789



This runs:

foreground

no systemd

container-native

predictable lif
This single change fixed multiple restart loops and connection failures.

3.2 Binding is controlled by config, NOT CLI flags

Attempting to use:

--host 0.0.0.0



❌ Failed with:

error: unknown option '--host'



Instead, binding must be set in openclaw.json:

"gateway": {
"bind": "lan",
"port": 18789
}



This is why a bootstrap config patcher exists.

4. Bootstrap Script (Why It Exists)

A custom bootstrap.sh is used because:

openclaw setup is interactive by default

config must be created exactly once

config must be patched every boot

environment variables must be applied deterministically

Responsibilities of bootstrap.sh

Create /home/node/.openclaw

Run openclaw setup only if config missing

Patch:

gateway.mode = local

gateway.bind = lan

gateway.port

gateway.auth.mode = token

gateway.trustedProxies

Start gateway in foreground

This script is idempotent and safe to rerun.

5. Trusted Proxies (Critical for Reverse Proxy Setups)
   Problem encountered

Behind Traefik + Cloudflare:

Web UI connections were treated as “remote”

Pairing requests rotated rapidly

unknown requestId errors occurred

UI disconnected repeatedly

Root cause

OpenClaw could not trust X-Forwarded-For headers.

Required fix (non-optional)
"gateway": {
"trustedProxies": \[
"172.29.0.0/16",
"127.0.0.1",
"::1"
]
}



This must match:

Docker network used by Traefik (proxynet)

Any internal proxy hops

Without this:

pairing is unstable

approvals may silently fail

UI appears “broken”

6. Docker Networking Pitfall Encountered
   Symptom

Could not resolve host: clawd-gateway

Container showed attached network but no IP

Traefik returned 404 / page not found

curl failed with connection refused

Root cause

Docker network endpoint corruption:

container attached to proxynet

but endpoint had no IP / no gateway

Fix
docker compose down
docker rm -f clawd-gateway
docker compose up -d



If still broken:

docker network rm proxynet
docker network create proxynet



This is a Docker issue, not OpenClaw — but it presents as an OpenClaw failure.

7. Why the Web UI Initially “Did Not Exist”

OpenClaw’s gateway:

Is primarily a WebSocket service

Does not guarantee / serves a page

UI access is token-based via fragment (#token=...)

Therefore:

HTTP 404 at / is normal

WS connectivity is the real test

Traefik routing was correct even when browser showed “page not found”

8. Pairing Flow Is More Strict Than Expected
   Observed behavior

Web UI repeatedly showed “pairing required”

Approval attempts returned unknown requestId

Why

Pairing requests are ephemeral

Each reconnect generates a new request

Without trusted proxies, reconnects happen constantly

Correct pairing flow (documented elsewhere)

Open UI

Immediately list devices

Approve with local WS URL + token

Once paired, behavior stabilizes.

9. Skills Appearing “Blocked” Is Expected

This is not a misconfiguration.

OpenClaw is:

deny-by-default

scope-based

approval-driven

Many skills are intentionally blocked until:

agent has required scopes

operator approves action

This is a security feature, not a bug.

10. Files You Should NOT “Simplify Away”

Do not remove:

bootstrap.sh

gateway.bind = lan

gateway.trustedProxies

token-based auth

Traefik network isolation

Each exists to address a real failure mode encountered during setup.

11. What To Re-Check After Upgrades

After upgrading OpenClaw:

Confirm CLI flags did not change:

openclaw gateway --help



Verify bootstrap still runs gateway in foreground

Verify config patching still applies cleanly

Re-test:

curl http://clawd-gateway:18789



Confirm pairing still works

12. Summary: Non-Negotiables

These are intentional deviations:

❌ No systemd

❌ No service mode

❌ No implicit localhost trust

✅ Foreground gateway

✅ Config-based binding

✅ Explicit trusted proxies

✅ Token auth

✅ Manual pairing approval

Undoing any of these will likely reintroduce the original failures.

13. Final Note

This deployment path is not edge-case nonsense.

It represents:

how OpenClaw behaves in real infrastructure

how it should be documented upstream

how production users will actually run it

This file exists so you never have to rediscover that again.

