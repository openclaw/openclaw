---
summary: "Enable the Policy plugin and author `policy.jsonc`, with a minimal example covering every supported section"
read_when:
  - You are writing `policy.jsonc` for the first time
  - You want one example that covers every supported policy section
  - You need the cross-cutting authoring caveats behind the rule tables
title: "Author a policy file"
sidebarTitle: "Authoring"
---

Enabling the plugin and writing the policy artifact. Part of the [`openclaw policy`](/cli/policy) reference.

## Quick start

```bash
openclaw plugins enable policy
```

The plugin stays enabled even when `policy.jsonc` is missing, so doctor can
report the missing artifact instead of silently skipping checks.

Author `policy.jsonc` by hand; it is not generated from current settings. Each
top-level section is a rule namespace: a check only runs when a concrete rule
is present under it (unsupported sections or keys fail as
`policy/policy-jsonc-invalid` instead of being silently ignored). Minimal
example covering every supported section:

```jsonc validate=false
{
  "channels": {
    "denyRules": [
      {
        "id": "no-telegram",
        "when": { "provider": "telegram" },
        "reason": "Telegram is not approved for this workspace.",
      },
    ],
  },
  "mcp": {
    "servers": {
      "allow": ["docs"],
      "deny": ["untrusted"],
    },
  },
  "models": {
    "providers": {
      "allow": ["openai", "anthropic"],
      "deny": ["openrouter"],
    },
  },
  "network": {
    "privateNetwork": {
      "allow": false,
    },
  },
  "routing": {
    "requireBindings": true,
    "requireConfiguredChannels": true,
    "probes": [
      {
        "id": "family-dm",
        "route": {
          "channel": "imessage",
          "peer": { "kind": "direct", "id": "+15555550123" },
        },
        "expect": {
          "agentId": "family",
          "matchedBy": ["binding.peer"],
        },
      },
    ],
  },
  "ingress": {
    "session": {
      "requireDmScope": "per-channel-peer",
    },
    "channels": {
      "allowDmPolicies": ["pairing", "allowlist", "disabled"],
      "denyOpenGroups": true,
      "requireMentionInGroups": true,
    },
  },
  "gateway": {
    "exposure": {
      "allowNonLoopbackBind": false,
      "allowTailscaleFunnel": false,
    },
    "auth": {
      "requireAuth": true,
      "requireExplicitRateLimit": true,
    },
    "controlUi": {
      "allowInsecure": false,
    },
    "remote": {
      "allow": false,
    },
    "http": {
      "denyEndpoints": ["chatCompletions", "responses"],
      "requireUrlAllowlists": true,
    },
    "nodes": {
      "denyCommands": ["system.run"],
    },
  },
  "agents": {
    "workspace": {
      "allowedAccess": ["none", "ro"],
      "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
    },
  },
  "dataHandling": {
    "sensitiveLogging": {
      "requireRedaction": true,
    },
    "telemetry": {
      "denyContentCapture": true,
    },
    "retention": {
      "requireSessionMaintenance": true,
    },
    "memory": {
      "denySessionTranscriptIndexing": true,
    },
  },
  "secrets": {
    "requireManagedProviders": true,
    "denySources": ["exec"],
    "allowInsecureProviders": false,
  },
  "auth": {
    "profiles": {
      "requireMetadata": ["provider", "mode"],
      "allowModes": ["api_key", "token"],
    },
  },
  "execApprovals": {
    "requireFile": true,
    "defaults": { "allowSecurity": ["deny"] },
    "agents": {
      "allowSecurity": ["deny", "allowlist"],
      "allowAutoAllowSkills": false,
      "allowlist": { "expected": ["deploy", "status"] },
    },
  },
  "tools": {
    "requireMetadata": ["risk", "sensitivity", "owner"],
    "profiles": {
      "allow": ["messaging", "minimal"],
    },
    "fs": {
      "requireWorkspaceOnly": true,
    },
    "exec": {
      "allowSecurity": ["deny", "allowlist"],
      "requireAsk": ["always"],
      "allowHosts": ["sandbox"],
    },
    "elevated": {
      "allow": false,
    },
    "denyTools": ["group:runtime", "group:fs"],
  },
}
```

Cross-cutting notes not obvious from the [rule tables](/cli/policy/rules):

- Omitting `gateway.bind` while denying non-loopback binds means you accept
  the runtime default; set `gateway.bind: "loopback"` for strict conformance.
- For a read-only agent, set sandbox `mode` to `all` or `non-main` on the
  applicable defaults/agent and `workspaceAccess` to `none` or `ro`. Missing or
  `off` sandbox mode does not satisfy a read-only policy.
- `agents.workspace.denyTools` accepts `exec`, `process`, `write`, `edit`,
  `apply_patch`. The config tool-deny groups `group:fs` (file mutation) and
  `group:runtime` (shell/process) satisfy the equivalent posture.
- Exec-approvals checks read the live SQLite approvals document only when
  an `execApprovals` rule is present; a missing or invalid artifact is
  unobservable evidence, not a synthetic pass.
- Secret and auth-profile evidence records provider/source posture and
  SecretRef metadata only, never raw values. Policy does not read or attest
  per-agent credential stores such as `openclaw-agent.sqlite`.
- Data-handling evidence is config-level posture (telemetry capture toggle,
  session maintenance mode, transcript-indexing setting) plus the always-on log
  redaction invariant. It does not inspect logs, telemetry exports,
  transcripts, or memory files, and a clean result does not prove that no
  personal data or secrets exist in them.
- Routing probes reuse OpenClaw's runtime binding resolver. Routing evidence
  records only the probe id, resolved agent, match kind, and redacted binding
  metadata. It never records peer, account, guild, team, or role identifiers.
  Adding a routing section intentionally changes the policy and attestation
  hashes; policies without routing keep their existing evidence shape.
