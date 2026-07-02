---
summary: "Recipe for moving AI provider API keys outside the agent's reach via an external auth-injection proxy"
title: "External auth-injection proxy (recipe)"
sidebarTitle: "External auth proxy"
read_when:
  - Hardening a multi-tenant deployment where agent shell tools can read raw API keys
  - Working around the unsolved agent-self-read class of issues (#11829, #10659) without waiting on upstream changes
  - Designing credential storage that isolates the agent's tool runtime from outbound provider auth
---

OpenClaw resolves SecretRefs into an in-memory runtime snapshot. The values
sit in the gateway process's heap and are readable by anything that runs in
that process — including the agent's shell tool, `node -e fs.readFileSync`,
and `/proc/<self>/environ`. SecretRef protects the _config-storage_ surface
(no plaintext in `openclaw.json`), not the _runtime-readability_ surface.

If your threat model includes the agent reading its own credentials —
common in multi-tenant deployments and when agents have broad shell
permissions — the workaround is an **external auth-injection proxy**. This
recipe shows how to build one with OpenClaw's existing primitives. No core
changes are required.

<Note>
This recipe documents a pattern, not a feature. There is no built-in proxy.
You run a separate process that holds the credentials and rewrites
outbound requests. See [#11829](https://github.com/openclaw/openclaw/issues/11829) and [#10659](https://github.com/openclaw/openclaw/issues/10659) for upstream discussion of native solutions.
</Note>

## When to use this pattern

Use it when:

- An agent has shell-tool access broad enough to read arbitrary files
  (most multi-tenant setups).
- You don't trust the agent to behave correctly even when given legitimate
  outbound API access (prompt-injection mitigation, multi-tenant isolation).
- You can run a separate process at a different UID or in a separate
  container.

Skip it when:

- The agent runs in a fully-sandboxed environment where shell tools are
  pre-restricted.
- You only need protection against config-leak, not runtime-leak —
  SecretRef alone is sufficient for that.
- Inbound webhook signing secrets and JWT signing secrets — the proxy
  pattern doesn't help; those must live with the verifier.

## Architecture

```text
agent container (UID 1001)
  └─ POST http://localhost:18080/anthropic/v1/messages
       Authorization: <stripped by proxy>
                  │
                  ▼
auth-proxy process (different UID, separate container, OR systemd user)
  └─ Reads ANTHROPIC_API_KEY from systemd LoadCredential ramfs
  └─ Strips inbound x-api-key / Authorization
  └─ Injects: x-api-key: sk-ant-…
                  │
                  ▼
              api.anthropic.com
```

The trust boundary is **process/UID separation**. If the proxy runs as the
same UID in the same process tree as the agent, the agent can read
`/proc/<proxy-pid>/environ` and `/proc/<proxy-pid>/mem`. With a different
UID — or with the proxy in a separate container's PID namespace — those
reads return EACCES.

## Configuration

### 1. Run the proxy externally

The proxy can be anything that does HTTP forwarding with header rewriting —
nginx with `auth_request` + a tiny shim, a Go service, a Node script. The
relevant guarantees are:

- Different UID from the agent's process tree.
- Strips inbound `Authorization` and `x-api-key` headers (don't trust the
  agent's outbound auth).
- Injects the canonical auth header for the upstream provider.
- Streams response bodies through (don't buffer SSE chunks).

The essential structure is small enough to inline. A complete request handler
in stdlib-only Node looks like this:

```js
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDERS = {
  anthropic: { upstream: "api.anthropic.com", authHeader: "x-api-key", value: (k) => k },
  openai: { upstream: "api.openai.com", authHeader: "authorization", value: (k) => `Bearer ${k}` },
};
// Tenant identification by Docker bridge source IP; replace with whatever
// signal fits your deployment (cert SAN, request header, etc.). Each value
// names a file in $CREDENTIALS_DIRECTORY (set by systemd LoadCredential=).
const TENANTS = { "172.17.0.23": { anthropic: "anthropic_kellen" } };

const KEYS = new Map();
for (const t of Object.values(TENANTS))
  for (const file of Object.values(t))
    KEYS.set(file, readFileSync(join(process.env.CREDENTIALS_DIRECTORY, file), "utf8").trim());

http
  .createServer((req, res) => {
    const [, providerName, path = "/"] = req.url.match(/^\/([^/?#]+)(.*)$/) || [];
    const provider = PROVIDERS[providerName];
    const tenant = TENANTS[req.socket.remoteAddress?.replace(/^::ffff:/, "")];
    if (!provider || !tenant?.[providerName]) return res.writeHead(403).end();

    // Strip inbound auth, inject canonical header for the upstream.
    const headers = { ...req.headers, host: provider.upstream };
    delete headers.authorization;
    delete headers["x-api-key"];
    headers[provider.authHeader] = provider.value(KEYS.get(tenant[providerName]));

    const upstream = https.request(
      { host: provider.upstream, path, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      },
    );
    req.pipe(upstream);
  })
  .listen(18080, "172.17.0.1");
```

A worked-out version with logging, credential validation, and graceful shutdown
is published as a third-party reference at
[coletebou/Badland@`60b7dd6f`](https://github.com/coletebou/Badland/tree/60b7dd6ffd514e4fedce4f19e42ddd1c7bac57c1/badclaw/services/auth-proxy).
It is not maintained by the OpenClaw project and carries no support guarantee.
Pinning to a commit SHA insulates this page from drift in that repository.

### 2. Redirect OpenClaw to the proxy

In `openclaw.json`, set the provider's `baseUrl` to your proxy URL.
The `apiKey` field still has to satisfy schema (non-empty string) but its
value is irrelevant — your proxy will strip it before forwarding.

```json5
{
  models: {
    providers: {
      anthropic: {
        baseUrl: "http://localhost:18080/anthropic",
        apiKey: "NOT_USED_PROXY_INJECTS_AT_EGRESS",
        models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
      },
    },
  },
}
```

### 3. Remove the credential from the container's environment

In multi-container deployments (Docker Compose, Kubernetes), remove
`ANTHROPIC_API_KEY` and similar variables from the tenant's environment
entirely. If you have a fleet-wide `shared.env` with provider keys, override
each tenant's value to empty:

```bash
# tenant .env
ANTHROPIC_API_KEY=
```

This forces requests through the proxy. If the proxy is unavailable, calls
fail-closed at upstream auth — never silently fall back to a key in
`process.env`.

## Verification

After cutover, the agent should not be able to read the credential:

```bash
# All of these should return empty:
docker exec <tenant> sh -c 'env | grep ANTHROPIC_API_KEY'
docker exec <tenant> sh -c 'cat /run/secrets/anthropic 2>/dev/null'
docker exec <tenant> sh -c 'find /home /root /etc /run /var -type f 2>/dev/null \
  | xargs grep -l "<known-key-prefix>" 2>/dev/null'
```

A successful cutover preserves end-to-end completion latency — the localhost
hop adds ~0.1 ms, lost in the noise of LLM response time. Streaming TTFB is
unchanged when the proxy uses byte-pass-through (no buffering).

## Limitations

- **Single point of failure**: if the proxy is down, the agent loses LLM
  access. Pair with a process supervisor and health monitoring.
- **Eager credential load**: a static-key proxy reads keys once at startup.
  For OAuth tokens that rotate, you need live re-resolution at request
  time — see the related upstream discussion in [#9271](https://github.com/openclaw/openclaw/pull/9271).
- **Backups leak history**: if you previously stored keys inline in
  `openclaw.json`, scrub the historical `*.bak` files during migration.
- **Doesn't help inbound secrets**: HMAC verification, JWT signing, and
  webhook signature checks need the secret in the verifying process. Proxy
  pattern is outbound-only.
- **One service per host (or per tenant)**: scoping the proxy adds
  operational overhead. Multi-tenant proxies can identify tenants by
  source IP or a custom header set in the OpenClaw config.

## Related

- [Secrets management](/gateway/secrets) — SecretRef contract, runtime
  snapshot, and the difference between config-leak protection and
  runtime-leak protection
- [Authentication](/gateway/authentication) — gateway-side auth, separate
  from outbound provider auth
- [#11829](https://github.com/openclaw/openclaw/issues/11829) — Security
  Roadmap: Protecting API Keys from Agent Access
- [#10659](https://github.com/openclaw/openclaw/issues/10659) — Masked
  Secrets — Prevent Agent from Accessing Raw API Keys
- [#9271](https://github.com/openclaw/openclaw/pull/9271) — Earlier
  full-fat proxy implementation; closed unmerged but a useful reference
  for OAuth refresh, request body sniffing, and audit logging concerns
