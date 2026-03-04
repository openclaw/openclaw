# Secrets Management Architecture

OpenClaw implements a layered secrets architecture with two distinct blind modes:
**application-layer blind** and **OS-layer blind**. These address different threat models
and can be combined for defense-in-depth.

---

## Tier System

Secrets are classified into tiers that control access requirements:

| Tier         | Description                   | TTL                  | TOTP Required    |
| ------------ | ----------------------------- | -------------------- | ---------------- |
| `open`       | Low-risk, read-only secrets   | Unlimited            | No               |
| `controlled` | Moderate-risk, session-scoped | 4h default / 8h max  | Once per session |
| `restricted` | High-risk, write/admin access | 15m default / 1h max | Each access      |

---

## Application-Layer Blind

In `balanced` and `strict` security modes, agents receive **metadata instead of values**.

The Credential Broker intercepts tool calls and resolves `secret:<name>` references
at the last possible moment before passing parameters to the tool — the agent code
never holds the raw value in a variable it controls.

**What this protects against:**

- Agents logging or exfiltrating secret values through tool calls
- Prompt injection attacks that try to read and relay secrets
- Accidental exposure in agent reasoning traces

**Limitation:** The openclaw _process_ can still call `getSecret()` directly.
This is an application-layer control, not an OS-level isolation.

---

## OS-Layer Blind

For privileged secrets, OpenClaw implements a true OS-level blind using service user
separation. Controlled by `agentBlind: true` in the secret registry.

### Architecture

```
openclaw process (uid: openclaw)
  getSecret("cloudflare-api-token")
    └─ secretDef.agentBlind = true
    └─ getSecretViaBroker(name)
         └─ sudo -u sirbam /usr/local/libexec/openclaw/secrets-broker <name>
                  │ (root:wheel binary — openclaw cannot modify)
                  │
                  └─ reads from bamwerks.keychain-db (sirbam's keychain)
                  │    openclaw has ZERO direct access to this keychain
                  │
                  └─ echo -n "$secret" → stdout pipe only
                            │
                  openclaw receives value in memory
                  Used immediately, NOT written to disk
```

### What This Protects Against

- **Full openclaw process compromise**: Even with arbitrary code execution as `openclaw`,
  an attacker cannot read privileged secrets from any keychain they have access to
- **Direct keychain queries**: The entries do not exist in System Keychain
- **Memory persistence**: Value exists in openclaw's address space only for the operation

### Privileged Secrets (agentBlind: true)

| Secret                 | Description                                  |
| ---------------------- | -------------------------------------------- |
| `cloudflare-api-token` | Cloudflare API token (tunnel/DNS management) |
| `github-app-pem`       | GitHub App RSA private key                   |
| `github-app-ids`       | GitHub App ID and installation ID            |
| `github-oauth-app`     | GitHub OAuth client credentials              |

---

## Service User Separation (tasks#132)

Full OS-level isolation requires the `openclaw` service user to be a separate OS account
from the human user (`sirbam`). Current deployment:

- **`sirbam`** (uid 501): Human user. Owns `bamwerks.keychain-db`. Interactive sessions.
- **`openclaw`** (system user): AI process. No login shell. Zero keychain access to sirbam's data.

Without this separation, the OS blind is ineffective.

---

## Keychain Layout

| Keychain               | Owner  | Contents                                               | openclaw Access        |
| ---------------------- | ------ | ------------------------------------------------------ | ---------------------- |
| System Keychain        | root   | `anthropic-token`, `discord-token`, operational tokens | Direct read            |
| `bamwerks.keychain-db` | sirbam | Privileged API tokens, GitHub App credentials          | **None** (broker only) |

---

## Pending: System Keychain Cleanup (tasks#132)

Deletion of old System Keychain entries for the four privileged secrets requires root.
A cleanup script is available:

```bash
sudo bash /opt/openclaw/.openclaw/workspace/scripts/secrets-sysclean.sh
```

Until this is run, stale System Keychain entries remain (the values are also in
bamwerks keychain — bamwerks is authoritative). Sirbam should run with root access.

---

_Last updated: 2026-03-01 — OS-level blind implementation (Bishop/tasks#132)_
