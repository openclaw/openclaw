# Lobstah Provider

Bundled provider plugin for the **Lobstah** distributed inference grid: an OpenAI-compatible model provider backed by a peer-to-peer pool of Apple Mac mini workers, with Ed25519-signed federated receipts as the credit/accounting layer.

> Not to be confused with [`lobster`](../lobster/), which is the unrelated workflow-shell agent tool. (Different ID, different concern, both very crustacean.)

## What this is

- A model provider that openclaw can call like any other OpenAI-compatible endpoint.
- Under the hood, requests go to a `lobstah-router` running on the user's machine, which forwards to a peer worker (e.g. another Mac mini contributing compute) over the network.
- Workers sign a token-usage receipt for every request; the router validates and appends to a local ledger. Both ends accumulate a balance — earn credits by serving, spend by requesting.
- Streaming is supported (Server-Sent Events with the receipt embedded as an SSE comment line at tail).
- **Strictly opt-in for both contributing and consuming.** A worker only advertises itself when explicitly told to. A router only pulls peers from a tracker when the user explicitly syncs.

## Architecture

```
                          (opt-in advertise)
worker  ──signed announce──► tracker  ◄──signed announce── worker
                              │
                              │ (opt-in sync)
                              ▼
                            peers.json
                              │
openclaw ──/v1/chat/...──► lobstah-router ──forwards──► picked worker
                              │                              │
                              │  ◄────signed receipt─────────┤
                              ▼                              ▼
                          local ledger                   local ledger
```

## Setup (local-only, no tracker)

1. Build:
   ```sh
   pnpm install
   pnpm --filter "@lobstah/*" -r build
   ```
2. Generate an identity and start the router:
   ```sh
   node packages/lobstah-cli/dist/index.js keygen
   node packages/lobstah-cli/dist/index.js peers add <peer-pubkey> http://<peer-host>:17474
   node packages/lobstah-cli/dist/index.js router start
   ```
3. In openclaw, run `openclaw onboard` and pick "Lobstah grid". Accept the default base URL `http://127.0.0.1:17475/v1`. Any string for the API key works (the router does not check).

## Setup (with public tracker — fully opt-in)

To **discover** peers from a tracker:

```sh
node packages/lobstah-cli/dist/index.js peers sync https://tracker.example.com
```

To **advertise** your own worker on a tracker (heartbeats every TTL/2; sends signed `unannounce` on shutdown):

```sh
node packages/lobstah-cli/dist/index.js worker start \
    --announce-to https://tracker.example.com \
    --announce-url http://your-public-host:17474 \
    --announce-label my-mac
```

To **run a tracker yourself** (anyone can; trackers are deliberately dumb):

```sh
node packages/lobstah-cli/dist/index.js tracker start --port 17476
```

The openclaw onboarding wizard asks about both opt-ins explicitly, defaulting to **no** for each.

## Vendored packages

The grid runtime ships as seven small packages under `packages/lobstah-*`:

- `@lobstah/protocol` — Ed25519 identity, signed receipts + announcements (canonical JSON), Zod request schemas, replay-protection helpers
- `@lobstah/ledger` — append-only signed-receipt log + balance computation
- `@lobstah/engine-ollama` — `WorkerEngine` interface + Ollama adapter (chat + chatStream)
- `@lobstah/worker` — provider-side HTTP server (signs receipts, OpenAI-compat, optional auto-announce)
- `@lobstah/router` — local HTTP server openclaw points at (model-aware multi-peer routing with failover, receipt validation + nonce dedupe, append to ledger)
- `@lobstah/tracker` — opt-in discovery service (in-memory peer registry with TTL)
- `@lobstah/cli` — `keygen | worker start | router start | tracker start | peers add/remove/list/sync | balance`

## HTTP endpoints

**Router** (the one openclaw points at):

- `POST /v1/chat/completions` — OpenAI-compatible, streaming optional, model-aware peer selection with failover
- `GET /v1/models` — aggregates models from all configured peers (cached for 30s per peer)
- `GET /balance` — receipt-derived balance summary
- `GET /peers` — current local peer list

**Worker** (provider side):

- `POST /v1/chat/completions` — accepts request, calls engine, returns response with signed receipt header (or SSE-embedded receipt comment for streams)
- `GET /v1/models`, `GET /capacity` — what models this worker has, current queue depth
- `GET /pubkey` — worker's identity

**Tracker** (optional, public discovery):

- `POST /announce` — peer publishes a signed `Announcement` with TTL
- `POST /unannounce` — peer revokes its announcement (signed proof of pubkey ownership)
- `GET /peers` — anyone reads the current public peer list (signed announcements; clients verify)

## Trust + safety notes

- **Receipt replay protection.** Each receipt carries a 16-byte random `nonce` and a `completedAt` timestamp. Routers reject expired (>5 min) or duplicate-nonce receipts.
- **Announcement freshness.** Trackers reject stale or far-future announcements (±5 min skew window).
- **Trust model is cooperative.** Workers are assumed not to lie about model output. Adversarial workers (returning gibberish, returning a different model's output) can be addressed in v2 with redundancy + reputation.
- **No NAT traversal yet.** Workers must be reachable at the URL they advertise — public IP, port forwarding, or a Tailscale-style overlay. A v2 relay path can lift this restriction.
- **Cooperative failover.** If a peer goes unhealthy (2 consecutive connection failures), the router excludes it for 30 seconds and tries the next candidate.
