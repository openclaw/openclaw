---
title: "Environments"
summary: "Dev, staging, and production environment separation, config isolation, and secrets management"
read_when:
  - Setting up a new deployment environment
  - Understanding config and secrets separation between dev and prod
  - Adding or rotating credentials for a specific environment
---

# Environments

## Environment taxonomy

OpenClaw uses three logical environments. Each environment runs its own gateway instance
with its own config file (`~/.openclaw/openclaw.json` or a path set via `OPENCLAW_CONFIG`).

| Environment | Purpose | Config isolation | Secrets |
|---|---|---|---|
| **dev** | Local development, branch testing, unit test harness | Developer machine or CI runner; `OPENCLAW_SKIP_CHANNELS=1` | Developer API keys only; never prod credentials |
| **staging** | Pre-release validation, beta installs, live integration tests | Dedicated VPS or container; separate `~/.openclaw` directory | Beta / staging provider keys; no prod channel tokens |
| **production** | Live personal assistant deployment | Owner's machine or VPS; standard `~/.openclaw` path | Real channel tokens and API keys |

---

## Config isolation rules

1. **Never share config files between environments.** Use separate `OPENCLAW_CONFIG`
   paths or separate OS user accounts.
2. **Prod secrets must never appear in dev config.** Use fake or developer-specific
   provider API keys in dev and CI.
3. **CI runners must fence off real credentials.**
   Parity gate and unit test jobs set `OPENAI_API_KEY=""`, `ANTHROPIC_API_KEY=""`, etc.
   to hard-block accidental real API calls. Follow this pattern for any new CI job.
4. **Live test jobs** (`OPENCLAW_LIVE_TEST=1`) are the only CI jobs that receive real
   credentials, and only through encrypted GitHub Actions secrets — never in workflow
   source or environment files committed to the repo.

---

## Secrets management

OpenClaw uses a layered SecretRef system for runtime secret resolution.
See [`docs/gateway/secrets.md`](../gateway/secrets.md) for the full contract.

Key rules for production:

- Store provider API keys and channel tokens in `~/.openclaw/credentials/` or via
  the `SecretRef` env-var pattern — never hard-coded in `openclaw.json`.
- Rotate credentials through `openclaw config set` or the Control UI, not by editing
  the JSON file directly, to avoid syntax errors.
- For server deployments, use systemd `EnvironmentFile` or Docker `--env-file` to
  inject secrets as environment variables without embedding them in the image or config.

### GitHub Actions secrets checklist

| Secret name | Used in | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Live test jobs only | Never in parity gate or unit jobs |
| `ANTHROPIC_API_KEY` | Live test jobs only | Never in parity gate or unit jobs |
| `NPM_NPMJS_TOKEN` | Dependabot npm registry | Secops-owned |
| `NPM_PUBLISH_TOKEN` | npm release workflow | Release managers only |
| `OPENCLAW_LIVE_GEMINI_KEY` | Live test jobs | See parity gate fencing |

Rotate secrets annually or immediately on suspected exposure. Log rotation events in the
private maintainer docs.

---

## Reproducible deploy process

### Standard single-user install (stable)

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

This installs the daemon (launchd on macOS, systemd on Linux) and runs onboarding.
The daemon starts automatically on login and restarts after crashes.

### Self-hosted VPS or Docker

```bash
# Docker (recommended for VPS)
docker compose up -d

# Verify
openclaw health --json
```

See [`docker-compose.yml`](../../docker-compose.yml) and
[`docs/install/docker`](https://docs.openclaw.ai/install/docker) for the full guide.

### Config validation at startup

Always run doctor after install or config changes:

```bash
openclaw doctor
```

For headless/automation:

```bash
openclaw doctor --yes --repair
```

This validates config, migrates legacy keys, and surfaces risky DM policies.
Treat doctor failures as blocking — do not proceed with a broken config.

---

## Environment variable reference

| Variable | Effect |
|---|---|
| `OPENCLAW_CONFIG` | Override the config file path |
| `OPENCLAW_SKIP_CHANNELS` | Skip channel startup (dev/CI) |
| `OPENCLAW_LIVE_TEST` | Enable live provider tests |
| `OPENCLAW_LIVE_TEST_QUIET` | Suppress live test noise (default 1) |
| `OPENCLAW_VITEST_MAX_WORKERS` | Cap test worker count (memory pressure) |
| `OPENCLAW_VITEST_POOL` | Override Vitest pool (threads/forks) |
| `OPENCLAW_LOCAL_CHECK` | Enable host-aware local-check profile |
| `OPENCLAW_LOCAL_CHECK_MODE` | `throttled` / `full` check mode override |
| `FAST_COMMIT` | Skip hook format + check (commit loop only) |

---

## Drift prevention

- Configuration schema docs are generated and hash-checked via
  `pnpm config:docs:check` / `pnpm config:docs:gen`.
  Run the gen command and commit the updated `.sha256` file whenever the schema changes.
- Plugin SDK API drift is checked via `pnpm plugin-sdk:api:check` /
  `pnpm plugin-sdk:api:gen`. Same pattern — commit the hash on any SDK surface change.
- Dead-code drift is reported by `pnpm deadcode:ci` in CI.
  Review the `knip.txt` artifact periodically and file issues for significant dead-code
  accumulation.
