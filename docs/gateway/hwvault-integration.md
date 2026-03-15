---
summary: "Integrate OpenClaw SecretRefs with hwvault (TPM/passkey/fingerprint-backed)"
read_when:
  - You want OpenClaw secrets sourced from hwvault
  - You want hardware-backed unlock + policy gate before agent secret access
title: "HWVault Integration"
---

# HWVault integration

This guide shows how to wire `hwvault` into OpenClaw using SecretRef **exec providers**.

The model is:

- OpenClaw stores **refs**, not plaintext credentials.
- OpenClaw calls a local resolver binary using the exec provider protocol.
- The resolver fetches values from `hwvault` (which can be TPM/passkey/fingerprint gated).

## Why this pattern

- Keeps long-lived secrets out of `openclaw.json`.
- Lets you enforce hardware-backed unlock outside request hot paths.
- Works with existing OpenClaw `secrets audit/configure/apply/reload` flows.

## 1) Install and initialize hwvault

Example (adjust to your environment):

```bash
hwvault init
hwvault unlock
```

Store secret material under stable names (example):

```bash
hwvault store openai-api-key ignored-user "sk-..."
hwvault store anthropic-api-key ignored-user "sk-ant-..."
```

## 2) Add an OpenClaw exec provider

Add a provider that calls a local resolver script/binary:

```json5
{
  secrets: {
    providers: {
      hwvault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-hwvault-resolver",
        passEnv: ["PATH", "HOME"],
        timeoutMs: 5000,
        jsonOnly: true,
      },
    },
    defaults: {
      exec: "hwvault",
    },
  },
}
```

Then use SecretRefs in credential fields:

```json5
{
  models: {
    providers: {
      openai: {
        apiKey: { source: "exec", provider: "hwvault", id: "openai-api-key" },
      },
      anthropic: {
        apiKey: { source: "exec", provider: "hwvault", id: "anthropic-api-key" },
      },
    },
  },
}
```

## 3) Resolver contract (stdin/stdout)

OpenClaw sends:

```json
{ "protocolVersion": 1, "provider": "hwvault", "ids": ["openai-api-key"] }
```

Resolver returns:

```json
{ "protocolVersion": 1, "values": { "openai-api-key": "sk-..." } }
```

You may also return per-id errors:

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": {
    "openai-api-key": { "message": "not found" }
  }
}
```

## 4) Minimal resolver example

This example maps each OpenClaw `id` to `hwvault get <id>` and returns the password field.

```bash
#!/usr/bin/env bash
set -euo pipefail

req="$(cat)"
ids_json="$(jq -c '.ids // []' <<<"$req")"

values='{}'
errors='{}'

while IFS= read -r id; do
  if out="$(hwvault get "$id" 2>/dev/null)"; then
    # expected format from hwvault get: Name/User/Pass/... lines
    pass="$(awk -F': ' '/^Pass:/ {print $2; exit}' <<<"$out")"
    if [[ -n "$pass" ]]; then
      values="$(jq --arg id "$id" --arg v "$pass" '. + {($id): $v}' <<<"$values")"
    else
      errors="$(jq --arg id "$id" '. + {($id): {"message":"secret payload missing Pass field"}}' <<<"$errors")"
    fi
  else
    errors="$(jq --arg id "$id" '. + {($id): {"message":"hwvault get failed"}}' <<<"$errors")"
  fi
done < <(jq -r '.[]' <<<"$ids_json")

jq -n --argjson values "$values" --argjson errors "$errors" '{
  protocolVersion: 1,
  values: $values,
  errors: (if ($errors|length) > 0 then $errors else empty end)
}'
```

Hardening recommendations:

- Keep resolver executable root-owned and non-writable by other users.
- Restrict accepted `id` values (allowlist/prefix checks).
- Add policy checks before returning secrets (agent/session mapping).
- Emit audit logs without writing secret values.

## 5) Delegation: short-lived tokens for agents

For high-trust setups, avoid returning long-lived static secrets directly to agent-callers.
Issue short-lived, one-time delegation tokens and redeem them only where needed.

Example flow:

1. `delegate-issue <id> [ttlSeconds]` on resolver side
2. pass token to the agent task runtime
3. `delegate-redeem <token>` right before use
4. token is consumed and cannot be replayed

Notes:

- Keep TTL short (for example 60–300s).
- Scope tokens per secret id and requester identity when possible.
- Deny by default on policy mismatch.

## 6) Auditability requirements

A production-grade integration should keep a tamper-evident audit trail for secret resolution decisions:

- event fields: timestamp, requester, secret id, decision, reason
- hash-chain or signed-event integrity metadata
- strict redaction (never log secret payloads)

## 7) Apply + verify

```bash
openclaw secrets audit --check
openclaw secrets reload
openclaw secrets audit --check
```

If using migration helpers:

```bash
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets reload
```

## Release gate checklist (recommended)

Before shipping to production, require all of the following:

- merge-clean integration path to current OpenClaw main
- hardware trust-root verification (TPM/YubiKey) in real-host tests
- short-lived delegation token enforcement (TTL + one-time redemption)
- policy enforcement (deny-by-default)
- tamper-evident audit trail and redaction checks

## Notes

- OpenClaw currently treats hwvault as an external resolver via `source: "exec"`.
- This gives immediate compatibility without adding a new built-in secret source type.
- For stronger delegation, have the resolver issue short-lived tokens or enforce per-agent policy before resolving each id.
