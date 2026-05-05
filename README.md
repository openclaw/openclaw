# OpenClaw (fork)

This repository is **[markmhendrickson/openclaw](https://github.com/markmhendrickson/openclaw)**, a fork of **[openclaw/openclaw](https://github.com/openclaw/openclaw)**. It keeps upstream behavior and adds a small set of changes aimed at **Codex + Docker** and **WhatsApp** reliability.

## Upstream project

For the full product overview, install flow, sponsors, and documentation, use the **canonical upstream README**:

**[OpenClaw — README (upstream)](https://github.com/openclaw/openclaw/blob/main/README.md)** · [Repository](https://github.com/openclaw/openclaw) · [Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai)

Everything below describes **only what differs in this fork**.

## Fork-specific changes

### 1. Gateway startup loads provider-owned plugins for the primary model

When the configured primary model is owned by a provider plugin (for example **Codex**), that plugin must be part of the **gateway startup** plugin set so harnesses register **before** channels start. Otherwise you can see errors such as **requested agent harness `codex` is not registered**.

- **Code:** [`src/plugins/channel-plugin-ids.ts`](src/plugins/channel-plugin-ids.ts) — resolve the configured model ref, map to owning plugin IDs, and merge them into startup resolution.
- **Tests:** [`src/plugins/channel-plugin-ids.test.ts`](src/plugins/channel-plugin-ids.test.ts)

### 2. WhatsApp: recent history for channel actions

WhatsApp-backed agents can use **recent inbound chat history** for follow-up channel actions instead of operating without context.

- **Code:** [`extensions/whatsapp/`](extensions/whatsapp/) (channel actions, inbound monitor, types) plus shared message-action / config wiring under `src/`.

### 3. Docker: Codex OAuth callback and helper script

Default Docker compose exposes the **Codex OAuth** callback port and related wiring so subscription-based Codex auth can complete inside the stack.

- **Compose:** [`docker-compose.yml`](docker-compose.yml) — publishes **`1455:1455`** for the callback path used with Codex OAuth in the gateway/CLI network namespace.
- **Helper:** [`scripts/docker/openai-codex-auth.sh`](scripts/docker/openai-codex-auth.sh)

For a **local-only** overlay (bind mounts for `~/.codex`, Codex binary path, `user: node`, etc.), keep a separate `docker-compose.extra.yml` on your machine; it is intentionally **not** tracked here (see `.gitignore`).

## Branches and upstream

- Default work that may be proposed upstream lives on branches such as **`mh/local-main-…`** with focused commits.
- To refresh this fork from upstream: merge or rebase **`openclaw/openclaw`** `main` into your branch, then push to **`markmhendrickson/openclaw`**.

## License

Same as upstream: see [LICENSE](LICENSE).
