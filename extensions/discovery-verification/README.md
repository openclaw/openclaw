# @openclaw/discovery-verification-plugin

A bundled OpenClaw extension that fetches structured capability metadata from
`/.well-known/agent-discovery.json` (Agent Discovery Protocol, ADP) before tool
calls to external domains, and surfaces capability signals into the tool call
log.

> **Status:** PoC. First commit lands the ADP resolver only. Follow-up commits
> will add an A2A Agent Card resolver (`/.well-known/agent.json`, A2A Protocol
> shape) and an `agent.json` resolver (Agent Internet Runtime shape) behind the
> same hook surface. See [openclaw/openclaw#66474][issue].

## What it does

When OpenClaw is about to call a network tool (`web_fetch`, `web_search`,
`fetch`, etc.) against an external domain, this plugin:

1. Extracts the target host from the tool params.
2. Fetches `https://{host}/.well-known/agent-discovery.json`.
3. Validates the payload (FQDN check, SSRF block, body size cap, schema check).
4. Caches the result for `cacheTtlSeconds` (default 1 hour).
5. Logs the declared services so they show up in the tool call log alongside
   whatever the tool itself does next.

The first commit is **observability only**. The plugin never blocks a tool
call, never modifies params, and never throws. Block / allow semantics arrive
in a later commit, gated by spec convergence and an explicit config flag.

## Why three formats, not one

There are currently three discovery-adjacent specs landing on the same
`/.well-known/` pattern with different shapes:

| Format        | Path                                  | Source                                       |
|---------------|---------------------------------------|----------------------------------------------|
| ADP           | `/.well-known/agent-discovery.json`   | walkojas-boop/agent-discovery-protocol       |
| A2A Agent Card| `/.well-known/agent.json`             | A2A Protocol (microsoft, google)             |
| `agent.json`  | `/.well-known/agent.json`             | FransDevelopment / Agent Internet Runtime    |

OpenClaw should not pick a winner. This plugin is structured so each format
gets its own resolver behind the same `before_tool_call` hook, and the
`DiscoveryResult` type is a discriminated union with a `format` tag. A
consuming agent can use whichever resolver(s) match what's actually published
in its environment.

The first commit ships the ADP resolver. The A2A Agent Card and `agent.json`
resolvers will land in subsequent commits as separate, independently-reviewable
changes.

## Configuration

```jsonc
// openclaw.json
{
  "plugins": {
    "discovery-verification": {
      "enabled": true,
      "cacheTtlSeconds": 3600,
      "requestTimeoutMs": 5000,
      "maxBodyBytes": 1048576,
      "logCapabilitySignals": true
    }
  }
}
```

All fields are optional. Defaults are safe.

## Security posture

The resolver enforces, in order:

- **FQDN validation** — rejects IP literals, embedded schemes, userinfo, and
  single-label hosts before any I/O.
- **SSRF** — resolves DNS, rejects loopback / RFC1918 / link-local /
  cloud-metadata / CGNAT / IPv6 ULA / IPv6 loopback / IPv6 link-local /
  IPv4-mapped private ranges. If ANY resolved IP is in a blocked range, the
  whole lookup fails — an attacker must not be able to mix one private entry
  into a multi-A record.
- **No redirects** — `fetch` is called with `redirect: "manual"` and any 3xx
  response is rejected.
- **Body size cap** — checks `Content-Length` (fast reject) then bounded
  streaming read. Default cap: 1 MiB.
- **Schema validation BEFORE caching** — a malformed payload returns a
  transient error and is NOT cached, so it can't poison the cache.
- **Negative cache for authoritative misses only** — 404/410 are cached
  (default TTL: 1 hour). Timeouts, network errors, malformed JSON, and
  schema failures are NOT cached.

> **Note:** This first commit uses the runtime's built-in `fetch`. A follow-up
> will swap in `fetchWithWebToolsNetworkGuard` from
> `src/agents/tools/web-guarded-fetch.ts` once the plugin SDK exposes it, so
> the SSRF guard is enforced consistently with the rest of OpenClaw's network
> tools.

## Tests

```bash
pnpm --filter @openclaw/discovery-verification-plugin test
```

Coverage:

- `domain-extractor.test.ts` — URL parsing, scheme/host filtering, IP literal
  rejection
- `cache.test.ts` — TTL behavior, expiry on access, positive/negative entries
- `adp-resolver.test.ts` — FQDN validation, IP block list (v4 + v6 + mapped),
  schema validation, all resolve outcomes (ok / not-found / transient), SSRF
  edge cases (mixed multi-A), body size cap (declared + actual), redirect
  blocking, malformed JSON

## Related

- [openclaw/openclaw#66474][issue] — original feature request
- [openclaw/openclaw#53500][trust-issue] — adjacent trust verification proposal
- [openclaw/openclaw#60502][a2a-pr] — A2A Agent Card landing in core
- [walkojas-boop/agent-discovery-protocol][adp-spec] — ADP v0.1 spec

[issue]: https://github.com/openclaw/openclaw/issues/66474
[trust-issue]: https://github.com/openclaw/openclaw/issues/53500
[a2a-pr]: https://github.com/openclaw/openclaw/pull/60502
[adp-spec]: https://github.com/walkojas-boop/agent-discovery-protocol
