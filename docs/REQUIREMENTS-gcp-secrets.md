# Requirements: External Secrets Management for OpenClaw

**Issue:** [openclaw/openclaw#13610](https://github.com/openclaw/openclaw/issues/13610)
**Author:** Rye (AI) + Amichay Oren
**Date:** 2026-02-15
**Status:** Draft

---

## 1. Problem Statement

OpenClaw stores all credentials (API keys, tokens, secrets) in plaintext files on disk. This creates the following problems:

1. **Exposure** — Anyone with shell access can read all secrets
2. **No isolation between agents** — In a multi-agent setup, all agents share filesystem access to all credential files. There is no way to restrict Agent A from reading Agent B's secrets.
3. **No audit trail** — No visibility into when secrets were accessed or by whom
4. **Rotation friction** — Changing a secret requires manual file edits and service restarts
5. **Version control conflict** — Config files containing secrets can't be safely committed to git
6. **Compliance** — Enterprise deployments require centralized secrets management

## 2. Goals

1. Secrets must be stored in a centralized, encrypted, access-controlled secrets store — not in plaintext files
2. Agents must be able to retrieve secrets they are authorized to access, at runtime
3. Each agent's access to secrets must be independently controllable (agent-level isolation)
4. The system must be able to set itself up from scratch (create the secrets store, enable required APIs, configure access controls) if nothing exists yet
5. Existing plaintext secrets must be automatically migrated to the secrets store and purged from disk
6. The solution must not break existing OpenClaw installations that don't use a secrets store
7. Secrets that cannot be rotated automatically must be tracked with rotation reminders, so administrators are proactively alerted when keys are due for review or have stopped working

## 3. Scope

### In Scope
- GCP Secret Manager as the first secrets provider
- Bootstrapping: automated setup of GCP Secret Manager (enable APIs, create resources, configure IAM) when it doesn't exist
- Secret references in OpenClaw config files, resolved at runtime
- Per-agent secret isolation via access controls
- Migration tool: automatically move existing plaintext secrets to the store and purge originals
- CLI commands for managing secrets
- Documentation

### Out of Scope (future work)
- Other providers (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault) — should follow the same pattern established here *(now in scope — see [multi-provider requirements](https://github.com/amor71/openclaw-secrets-providers/blob/main/REQUIREMENTS.md))*
- Automatic secret rotation via provider-native mechanisms *(now in scope — see multi-provider requirements §11)*
- UI for managing secrets

## 4. Functional Requirements

### 4.1 Secret Storage & Retrieval

- Secrets must be stored in GCP Secret Manager, not on the local filesystem
- Agents must be able to reference secrets in configuration files without knowing the actual values
- Secrets must be fetched at runtime when needed
- Retrieved secrets must be cached in memory to avoid repeated network calls
- Cached secrets must never be written to disk
- Secret values must never appear in logs, error messages, or API responses

### 4.2 Per-Agent Isolation

- In a multi-agent setup, each agent must only be able to access secrets it is authorized for
- It must be possible to grant Agent A access to secret X without granting Agent B the same access
- The access control mechanism must use the secrets store's native access control (IAM), not application-level enforcement

### 4.3 Bootstrapping

When a user first enables the secrets provider:

- If the GCP Secret Manager API is not enabled, enable it
- If required IAM roles/service accounts don't exist, create them
- If per-agent service accounts are needed for isolation, create and configure them
- The bootstrapping must be idempotent (safe to run multiple times)
- The user must be informed of all changes being made and asked to confirm

### 4.4 Migration

For existing installations with plaintext secrets:

- Scan all known locations for plaintext secrets (config files, auth profiles, credential files)
- Upload each secret to the secrets store
- Replace plaintext values in config files with secret references
- Verify that all references resolve correctly
- Purge plaintext originals from disk
- Handle partial failures gracefully — never purge a secret that wasn't successfully stored
- Must be interactive (confirm before destructive actions) with an option to skip confirmation for automation

### 4.5 CLI

Users must be able to:

- Check the status of the secrets provider (is it set up? is it reachable?)
- Test that all secret references in the current config resolve successfully
- Manually store a new secret
- Run the migration from plaintext to secrets store
- Run the bootstrap setup

### 4.6 Error Handling

- If a secret cannot be retrieved, the error must clearly identify which secret failed and why (not found, permission denied, network error, provider not configured)
- A missing secret must not cause the entire system to crash — only the feature that depends on it should fail
- If the secrets provider is unreachable, previously cached values should be usable as a fallback

### 4.7 Backward Compatibility

- Existing OpenClaw installations that don't configure a secrets provider must continue to work exactly as they do today
- The secrets feature must be entirely opt-in
- No new required dependencies

## 5. User Stories

1. **As an OpenClaw admin**, I want to store API keys in an encrypted secrets store so they're not exposed in plaintext on my server
2. **As a multi-agent operator**, I want each agent to only access its own secrets, so a compromised or misbehaving agent can't read another agent's credentials
3. **As a new user**, I want the system to set up the secrets infrastructure for me, so I don't have to manually configure GCP Secret Manager, IAM roles, and service accounts
4. **As an existing user**, I want to migrate my current plaintext secrets to the store automatically, and have the old files cleaned up
5. **As a developer**, I want to commit my OpenClaw config to git without leaking secrets
6. **As a lead agent with sub-agents**, I want to grant my sub-agents access to only the secrets they need for their tasks (e.g., Chai gets Alpaca read-only keys but not my Anthropic key), without storing credentials in shared files on disk

## 6. Access & Prerequisites

The system has two distinct access contexts with different requirements:

### Setup-time (bootstrapping, migration)
- Performed once, by an administrator (human or privileged agent)
- Requires elevated GCP permissions: enable APIs, create secrets, configure IAM
- May require `gcloud` CLI or equivalent tooling on the host
- This is an explicit, interactive action — not something agents do autonomously

### Runtime (agents fetching secrets)
- Performed continuously, by agents during normal operation
- Requires only read access to specific secrets the agent is authorized for
- Must not require `gcloud` CLI — should work with standard application credentials (service account, compute metadata, workload identity)
- Agents should not need or have permissions to create, modify, or delete secrets
- On Compute Engine VMs: requires `cloud-platform` OAuth scope and the `roles/secretmanager.secretAccessor` IAM role on the VM's service account
- Documentation must include clear instructions for both `gcloud` CLI and GCP Console setup of these prerequisites

The requirements document must clearly distinguish which operations belong to which context, and what credentials/tools each requires.

## 7. Manual Key Rotation Reminders

Many secrets stored in the secrets manager are third-party API keys (e.g., Alpaca, Anthropic, OpenAI, Brave) that cannot be rotated programmatically — the provider issues a static key that must be manually regenerated in their dashboard. The system must help administrators stay on top of these keys.

### 7.1 Rotation Policy per Secret

- Each secret must support an optional rotation policy with:
  - `rotationType`: `"auto"` | `"manual"` | `"dynamic"` (default: `"manual"`)
  - `rotationIntervalDays`: recommended rotation interval in days (e.g., 90)
  - `lastRotated`: timestamp of the last known rotation (set automatically on secret version creation, or manually via CLI)
  - `expiresAt`: optional hard expiration date (if the provider issues keys with TTLs)
- Rotation policy metadata must be stored alongside the secret (e.g., as secret labels/annotations in GCP Secret Manager)

### 7.1.1 Recommended Rotation Intervals

Default rotation intervals should follow industry best practices (NIST SP 800-63B, cloud provider recommendations):

| Secret Type | Rotation | Recommended Interval | Rationale |
|-------------|----------|---------------------|-----------|
| Self-managed tokens (gateway, internal auth) | Auto | **30 days** | High privilege, zero cost to rotate. Follows AWS default and NIST guidance for high-value credentials. |
| Third-party API keys (OpenAI, Anthropic, Brave, etc.) | Manual | **90 days** | Requires human action in provider dashboard. 90 days balances security with operational burden. |
| Database credentials | Auto/Dynamic | **30 days** (static) / **1 hour** (dynamic/Vault) | Per NIST and cloud provider defaults. Dynamic credentials should be short-lived. |
| Email/SMTP passwords | Manual | **180 days** | Lower risk, higher friction to rotate. |
| Broker API keys (Alpaca, etc.) | Manual | **180 days** | Financial API keys — rotate semi-annually, or immediately on suspected compromise. |

- These defaults must be configurable per secret — they are recommendations, not hard requirements
- The system should apply the appropriate default interval based on secret type when no explicit interval is set
- `openclaw secrets remind list` should flag secrets that exceed their recommended interval

### 7.2 Reminder Notifications

- When a secret's `rotationIntervalDays` has elapsed since `lastRotated`, the system must emit a `secret:review-due` event
- When a secret's `expiresAt` is approaching (configurable threshold, default 14 days), emit `secret:expiring-soon`
- Reminders must be surfaced to the administrator via:
  - Agent notification in the active session (if running)
  - CLI: `openclaw secrets status` shows overdue/expiring secrets prominently
- Reminders must repeat at a configurable cadence (default: daily) until the secret is rotated or the reminder is snoozed
- Snooze: `openclaw secrets remind snooze --secret <name> --days <n>` to temporarily suppress reminders

### 7.3 Failure Detection

- If an agent receives a 401/403 error from an API call using a managed secret, the system should emit a `secret:auth-failed` event with the secret name
- This does not trigger auto-rotation (impossible for manual keys), but alerts the administrator that the key may be revoked, expired, or invalid
- The failed secret should be flagged in `openclaw secrets status`

### 7.4 CLI Commands

- `openclaw secrets remind list` — show all secrets with their rotation status, last rotated date, and next review due date
- `openclaw secrets remind set --secret <name> --interval-days <n>` — set or update rotation interval
- `openclaw secrets remind snooze --secret <name> --days <n>` — snooze reminder
- `openclaw secrets remind ack --secret <name>` — acknowledge rotation (updates `lastRotated` to now)

### 7.5 User Stories

7. **As an OpenClaw admin**, I want to be reminded when my API keys are due for rotation so I don't forget to regenerate them before they become a security risk
8. **As a multi-agent operator**, I want to know immediately if any of my agents' API keys stop working, so I can replace them before it impacts service
9. **As a security-conscious user**, I want visibility into which secrets haven't been rotated in a long time, so I can prioritize key hygiene

## 8. Open Questions

1. Should secrets be passable to exec tool environments? (e.g., a script that needs an API key)
2. Should there be an option to prevent startup entirely if any required secret is unresolvable?
3. How should the system handle secret versioning? (always latest, or allow pinning?)

---

*This document describes WHAT the system must do. The HOW (architecture, interfaces, data flow, technology choices) will be covered in the Design document.*
