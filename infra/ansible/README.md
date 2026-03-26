# Fleet Ansible — Upstream OpenClaw Deployment

Ansible infrastructure for deploying upstream OpenClaw (v2026.3.24) across the fleet, replacing the custom Python fork.

## Prerequisites

- Ansible 2.15+
- SSH access to all fleet nodes (via Tailscale)
- SOPS for secrets decryption
- Docker on all target nodes

## Fleet Topology

| Node | Tailscale IP | Mode | Role |
|------|-------------|------|------|
| Gateway VPS | 100.69.32.10 | gateway | Production gateway, Telegram |
| Kubuntu | 100.93.214.109 | node | GPU/brain, Ollama provider |
| Pop!_OS | 100.119.126.67 | node | Utility, knowledge |
| Mac | 127.0.0.1 (local) | gateway | Dev workstation |

## Quick Start

```bash
cd infra/ansible

# 1. Set secrets (export or use SOPS)
export OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="123:abc..."

# 2. Dry run
ansible-playbook playbooks/upstream.yml --check --diff

# 3. Deploy to Mac first (local validation)
ansible-playbook playbooks/upstream.yml --limit mac

# 4. Deploy to Gateway VPS
ansible-playbook playbooks/upstream.yml --limit gateway-vps

# 5. Deploy to all nodes (config + image pull only)
ansible-playbook playbooks/upstream.yml --limit nodes
```

## Playbooks

| Playbook | Purpose |
|----------|---------|
| `upstream.yml` | Deploy upstream OpenClaw to fleet |
| `rollback.yml` | Stop upstream, restart old fork |
| `smoke-test.yml` | Verify deployment health |

## Deployment Order

1. **Mac** — local development and validation
2. **Gateway VPS** — production gateway with Telegram
3. **Kubuntu** — node (image pull + config only in base phase)
4. **Pop!_OS** — node (image pull + config only in base phase)

## Stopping the Old Fork

The old fork is not stopped by default. To stop it during deployment:

```bash
ansible-playbook playbooks/upstream.yml --limit gateway-vps \
  -e openclaw_stop_fork=true
```

## Rollback

```bash
ansible-playbook playbooks/rollback.yml --limit gateway-vps
```

This stops the upstream container and restarts the old fork.

## Smoke Tests

```bash
ansible-playbook playbooks/smoke-test.yml
```

Checks: container health, HTTP `/healthz`, Telegram channel status, cross-node reachability, existing services (Supabase, Archon).

## Configuration

- **Inventory:** `inventory/hosts.yml` — per-host variables
- **Group vars:** `inventory/group_vars/` — shared and group-specific config
- **Role defaults:** `roles/openclaw_upstream/defaults/main.yml`
- **Templates:** `roles/openclaw_upstream/templates/`

## Secrets

Secrets are injected via environment variables at deploy time. Never commit real values. The `upstream.env` file is deployed with mode 0600.

Required secrets:
- `OPENCLAW_GATEWAY_TOKEN` — shared gateway auth token
- `ANTHROPIC_API_KEY` — Anthropic API key
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (gateway only)

## Spec Reference

See `docs/superpowers/specs/2026-03-25-base-platform-migration-design.md` for the full design spec.
