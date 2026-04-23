---
doc_id: rbk_2cf16fb45b1c
title: OpenClaw safe host deployment overview
type: ops_sop
lifecycle_state: active
owners:
  primary: platform
tags:
  - openclaw
  - safe-host
  - deployment
  - local-first
  - gateway
aliases:
  - openclaw install
  - open claw install
  - safe openclaw setup
  - openclaw safe host
  - openclaw deployment
scope:
  service: openclaw-gateway
  feature: safe-host-deployment
  plugin: local-first-privacy
  environments:
    - operator-desktop
validation:
  last_validated_at: "2026-04-22"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: /home/ebatter1/Documents/openclaw-safe-install/README.md
retrieval:
  synopsis: Broad OpenClaw safe-host setup overview covering the operator-desktop install, staged deployment artifacts, and pointers to focused routing/config runbooks.
  hints:
    - openclaw install
    - open claw install
    - safe host deployment
    - openclaw deployment
    - safe host
    - staged install
    - deployment overview
    - operator-desktop
    - /var/lib/openclaw/.openclaw
    - /home/ebatter1/Documents/openclaw-safe-install
  not_for:
    - oh-my-codex pipx install
    - tailscale boot persistence
    - runbook authoring style
    - openclaw local-first model stack
    - openai oauth cloud routing
    - openclaw config file locations
    - openclaw service ownership status
  commands:
    - sudo /home/ebatter1/Documents/openclaw-safe-install/staging/apply-root-changes.sh --force-config
---

# Purpose

Keep the canonical overview for the hardened OpenClaw host deployment on this operator desktop.

This is the routing page for broad OpenClaw setup questions. Use the focused runbooks below for service status, local model routing, OAuth cloud routing, config locations, and the local-first privacy audit contract.

# Aliases

- `openclaw install`
- `open claw install`
- `safe openclaw setup`
- `openclaw safe host`
- `openclaw deployment`

# When to use

- A user asks how OpenClaw was installed or should be installed safely on this host.
- A user asks whether the OpenClaw deployment can use local models, OAuth cloud models, or both.
- A user asks broad questions about the staging directory under `/home/ebatter1/Documents/openclaw-safe-install`.
- A user asks about containment boundaries, service ownership, local-first routing, or the current high-level runtime state.

# Current deployment shape

- OpenClaw is installed under `/var/lib/openclaw/.openclaw`.
- The current persistent gateway is the `openclaw` user service `openclaw-gateway.service`.
- The older system `openclaw.service` is disabled to avoid port collisions on `127.0.0.1:18789`.
- Gateway UI assets are pinned outside the package tree at `/var/lib/openclaw/control-ui`.
- OpenClaw binds loopback, uses token auth, and keeps mDNS disabled.
- The deployment uses native Ollama as the local fallback path.
- Cloud-capable roles can use `openai-codex/*` OAuth-backed models when privacy checks pass.
- Local-first privacy routing, redaction, and audit logging are handled by `local-first-privacy`.

# Staged source of truth

Primary staged source:

```text
/home/ebatter1/Documents/openclaw-safe-install/README.md
```

Important staged artifacts:

- `staging/openclaw.json`
- `staging/openclaw.env`
- `staging/local-first-routing-policy.json`
- `staging/apply-root-changes.sh`
- `staging/extensions/local-first-privacy/`
- `staging/extensions/google-calendar-guarded/`
- `staging/extensions/signal-transcript-archive/`
- `staging/extensions/codex-session/`
- `staging/local-stt/`

# Focused runbooks

- `rbk_openclaw_gateway_service_ownership_status`: service ownership, status checks, restarts, and port `18789`.
- `rbk_openclaw_local_first_model_stack`: local model recommendations, Ollama, local fallback, and model aliases.
- `rbk_openai_oauth_cloud_routing`: ChatGPT/OpenAI OAuth-backed cloud routing and privacy checks.
- `rbk_openclaw_config_file_locations`: live and staging config file locations.
- `rbk_local_first_privacy_sensitive_precheck_schema_redaction`: sensitive precheck, redaction audit events, and provider metadata preservation.

# Validation

Run the current service checks:

```bash
systemctl --user -M openclaw@ status openclaw-gateway.service
systemctl status openclaw.service
ss -lptn 'sport = :18789'
```

Expected state:

- `openclaw-gateway.service` under the `openclaw` user bus is enabled and active.
- `openclaw.service` system unit is disabled and inactive.
- `127.0.0.1:18789` is owned by a single OpenClaw gateway process.

# Related runbooks

- `rbk_openclaw_gateway_service_ownership_status`
- `rbk_openclaw_local_first_model_stack`
- `rbk_openai_oauth_cloud_routing`
- `rbk_openclaw_config_file_locations`
- `rbk_local_first_privacy_sensitive_precheck_schema_redaction`

# Change history

- 2026-04-22: Canonicalized imported `Readme` record into an active OpenClaw safe host deployment overview while preserving `doc_id: rbk_2cf16fb45b1c`.
