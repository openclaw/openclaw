---
summary: "Network-isolated web search using SearXNG as a controlled egress gateway"
read_when:
  - You want to restrict agent internet access to search-only
  - You need to audit all agent web queries
  - You want network-level isolation for Docker deployments
  - You want to control which search engines agents can use
title: "SearXNG Network Isolation"
---

# SearXNG network isolation

> **This is optional.** The SearXNG provider works with any reachable instance —
> bare-metal, VM, LXC, Docker, or remote. Just set `tools.web.search.searxng.url`
> and you're done. This guide adds an **opt-in** Docker network isolation layer
> on top of that for deployments with stricter security requirements.

Run SearXNG as a **network-isolated search gateway** so that OpenClaw agents can
search the web but cannot make arbitrary outbound connections.

## Why isolate?

In a standard deployment, the OpenClaw gateway has unrestricted internet access.
When an agent uses `web_search`, results flow through the configured provider
API — but the gateway process itself can reach any host. This is fine for most
use cases, but some deployments need tighter control:

- **Compliance**: audit every query the agent makes to the public internet
- **Containment**: prevent agents from exfiltrating data via arbitrary HTTP
- **Engine control**: restrict which search engines serve results (e.g. no social media, no file-sharing)
- **Rate governance**: enforce query budgets at the network layer, not just application config

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  internal network (no internet)                     │
│                                                     │
│  ┌──────────────┐       ┌──────────────────────┐   │
│  │ openclaw-gw  │──────▶│      searxng         │   │
│  │ openclaw-cli │ :8080 │  (bridge to egress)  │   │
│  └──────────────┘       └──────────┬───────────┘   │
│                                     │               │
└─────────────────────────────────────┼───────────────┘
                                      │
┌─────────────────────────────────────┼───────────────┐
│  egress network (internet access)   │               │
│                                     ▼               │
│                          upstream search engines    │
│                     (brave, duckduckgo, startpage,  │
│                      wikipedia, stackoverflow)      │
└─────────────────────────────────────────────────────┘
```

**How it works:**

1. Docker's `internal: true` flag on the internal network blocks all outbound
   traffic — containers on this network cannot reach any host outside Docker.
2. SearXNG is attached to **both** networks. It receives search API requests on
   the internal network and forwards them to upstream engines via the egress network.
3. OpenClaw containers are attached **only** to the internal network. Their sole
   path to the public internet is the SearXNG JSON API on port 8080.

## Quick start

```bash
# From the openclaw repo root:
docker compose \
  -f docker-compose.yml \
  -f docker-compose.searxng-isolated.yml \
  up -d
```

Then configure OpenClaw to use the containerized SearXNG:

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
        searxng: {
          // "searxng" resolves via Docker DNS on the internal network
          url: "http://searxng:8080",
        },
      },
    },
  },
}
```

## What's included

| File                                    | Purpose                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `docker-compose.searxng-isolated.yml`   | Compose overlay defining networks, SearXNG service, and gateway network overrides |
| `scripts/searxng-isolated/settings.yml` | Hardened SearXNG config with curated 5-engine allowlist and JSON-only output      |
| `scripts/searxng-isolated/limiter.toml` | Rate limiter: 60 QPM sustained / 30 burst for JSON API                            |

## Customizing the engine allowlist

The default `settings.yml` enables 5 engines chosen for reliability and
complementary coverage:

| Engine        | Category | Lab results   | Notes                        |
| ------------- | -------- | ------------- | ---------------------------- |
| DuckDuckGo    | general  | 6/28 results  | Privacy-focused, no tracking |
| Brave         | general  | 20/28 results | Highest result volume        |
| Startpage     | general  | 2/28 results  | Google proxy, no tracking    |
| Wikipedia     | general  | reference     | High-signal for research     |
| StackOverflow | it, q&a  | reference     | Essential for coding tasks   |

These numbers come from testing against a live SearXNG instance with 85
engines enabled — only 3 engines returned results for a general query,
confirming that a focused allowlist loses nothing while reducing attack
surface.

To add engines, uncomment sections in `settings.yml`:

```yaml
# News engines (for current-events tasks)
- name: google news
  engine: google_news
  shortcut: gn
  disabled: false

# Science engines (for research tasks)
- name: arxiv
  engine: arxiv
  shortcut: arx
  disabled: false
```

## Verifying isolation

After `docker compose up`, confirm the network topology:

```bash
# 1. SearXNG should be reachable from the gateway
docker exec openclaw-gateway \
  wget -qO- http://searxng:8080/ > /dev/null && echo "OK"

# 2. Gateway should NOT be able to reach the internet
docker exec openclaw-gateway \
  wget -qO- --timeout=3 http://example.com 2>&1 | grep -q "bad address" && \
  echo "ISOLATED: no internet access"

# 3. SearXNG should be able to reach the internet (for upstream queries)
docker exec openclaw-searxng \
  wget -qO- --timeout=3 http://example.com > /dev/null 2>&1 && \
  echo "EGRESS: searxng has internet"

# 4. Run a test search through the isolated path
docker exec openclaw-gateway \
  wget -qO- "http://searxng:8080/search?q=test&format=json" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d[\"results\"])} results from {set(r[\"engine\"] for r in d[\"results\"])}')"
```

## Monitoring

SearXNG has built-in metrics when `enable_metrics: true` is set in
`settings.yml`. Query volume, engine response times, and error rates are
available at `http://searxng:8080/stats` (HTML) or via the `/config`
JSON endpoint.

For production deployments, you can:

- Mount a logging volume and parse SearXNG access logs
- Use the OpenClaw `config-audit.jsonl` log to correlate agent sessions with search queries
- Add a Prometheus exporter sidecar for Grafana dashboards

## Reliability

Lab testing showed SearXNG availability is not guaranteed even on LAN:

```
# Gateway health check logs from a Proxmox lab deployment:
#   Day 1: 10 unreachable events over ~2 hours (service restart)
#   Day 7:  7 unreachable events over ~6 hours (host maintenance)
#   Day 8+: 22 consecutive reachable checks (stable after recovery)
```

The Docker healthcheck in the compose file monitors SearXNG and will
restart it automatically. OpenClaw's built-in `web_search` error handling
returns a clear `searxng_unreachable` error to the agent when the instance
is down — the agent can then decide whether to retry or proceed without
search results.

## Comparison with non-isolated SearXNG

| Aspect          | Standard SearXNG            | Isolated SearXNG           |
| --------------- | --------------------------- | -------------------------- |
| Internet access | Gateway has full internet   | Gateway has none           |
| Search path     | Gateway → SearXNG → engines | Same, but only path        |
| Engine control  | SearXNG config              | Same                       |
| Audit           | SearXNG logs                | Same + network-level proof |
| `web_fetch`     | Works (direct HTTP)         | **Blocked** — no egress    |
| Arbitrary HTTP  | Works                       | **Blocked**                |

> **Note:** Network isolation blocks `web_fetch` since it requires direct HTTP
> access. If you need both `web_search` (isolated) and `web_fetch`, run SearXNG
> isolated but keep the gateway on a filtered network with egress rules instead
> of `internal: true`.

## Proxmox / LXC alternative

If you run OpenClaw on Proxmox, you can achieve the same isolation using LXC
firewall rules instead of Docker networks:

```bash
# On the Proxmox host, restrict the OpenClaw CT to only reach the SearXNG CT:
pct set <ct-openclaw> -firewall 1
# Allow OpenClaw → SearXNG
pvesh create /nodes/<proxmox-node>/lxc/<ct-openclaw>/firewall/rules \
  --type in --action ACCEPT --dest <searxng-ip> --dport 8080 --proto tcp
# Block all other egress
pvesh create /nodes/<proxmox-node>/lxc/<ct-openclaw>/firewall/rules \
  --type out --action DROP
```

Then configure OpenClaw with `tools.web.search.searxng.url: "http://<searxng-ip>:8080"`.
