# Shellgate

Optional per-account Bearer authentication for an existing trusted reverse proxy.
Caddy can keep authenticating browser users with Basic auth while Shellgate
verifies separate tokens for human or service subjects. OpenClaw continues to own
profiles, roles, device pairing, and session permissions.

Enable with `openclaw plugins enable shellgate`, then follow the
[Shellgate guide](https://docs.openclaw.ai/plugins/shellgate) before exposing a route.
`openclaw shellgate caddy` prints a maintained Caddy drop-in: import it before
the existing Basic-auth handler inside an ordered `route`. Credential commands
(`issue`, `list`, `rotate`, `revoke`) use administrator-scoped Gateway RPCs.
The plugin does not edit or start a proxy, change Gateway auth, or issue
Gateway/device tokens. It never writes a second account database.

## Validation

Run `pnpm test:extension shellgate` for real SQLite and HTTP credential tests.
With a locally available Caddy executable, run the optional real-proxy proof:

```sh
SHELLGATE_CADDY_BINARY=/path/to/caddy node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.live.config.ts extensions/shellgate/src/caddy.live.test.ts
```

This starts only disposable loopback listeners and uses synthetic credentials.
It covers the actual drop-in, unchanged Basic auth, Bearer verification, header
stripping, HTTP body forwarding, WebSocket upgrades, and revocation.
