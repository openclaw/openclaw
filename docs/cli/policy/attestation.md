---
summary: "Policy evidence, the attestation hash tuple, and `policy watch` drift detection"
read_when:
  - You need a policy attestation hash for audit evidence
  - You want to accept a clean policy state and detect later drift
  - You are wiring policy into a CI or release gate
title: "Accept and watch policy state"
sidebarTitle: "Attestation"
---

Recording a clean check as durable audit evidence, and detecting drift. Part of the [`openclaw policy`](/cli/policy) reference.

## Accept policy state

Example JSON output:

```json
{
  "ok": true,
  "attestation": {
    "checkedAt": "2026-05-10T20:00:00.000Z",
    "policy": {
      "path": "policy.jsonc",
      "hash": "sha256:..."
    },
    "workspace": {
      "scope": "policy",
      "hash": "sha256:..."
    },
    "findingsHash": "sha256:...",
    "attestationHash": "sha256:..."
  },
  "evidence": {
    "channels": [
      {
        "id": "telegram",
        "provider": "telegram",
        "source": "oc://openclaw.config/channels/telegram",
        "enabled": false
      }
    ],
    "mcpServers": [
      {
        "id": "docs",
        "transport": "stdio",
        "source": "oc://openclaw.config/mcp/servers/docs",
        "command": "npx"
      }
    ],
    "modelProviders": [
      {
        "id": "openai",
        "source": "oc://openclaw.config/models/providers/openai"
      }
    ],
    "modelRefs": [
      {
        "ref": "openai/gpt-5.6-sol",
        "provider": "openai",
        "model": "gpt-5.6-sol",
        "source": "oc://openclaw.config/agents/defaults/model"
      }
    ],
    "network": [
      {
        "id": "browser-private-network",
        "source": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
        "value": false
      }
    ],
    "gatewayExposure": [
      {
        "id": "gateway-bind",
        "kind": "bind",
        "source": "oc://openclaw.config/gateway/bind",
        "value": "loopback",
        "nonLoopback": false,
        "explicit": true
      }
    ],
    "agentWorkspace": [
      {
        "id": "agents-defaults-workspace-access",
        "kind": "workspaceAccess",
        "source": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
        "scope": "defaults",
        "value": "ro",
        "sandboxMode": "all",
        "sandboxModeSource": "oc://openclaw.config/agents/defaults/sandbox/mode",
        "sandboxEnabled": true,
        "explicit": true
      },
      {
        "id": "agents-defaults-tool-exec",
        "kind": "toolDeny",
        "source": "oc://openclaw.config/tools/deny",
        "scope": "defaults",
        "tool": "exec",
        "denied": true,
        "explicit": true
      }
    ],
    "secrets": [
      {
        "id": "vault",
        "kind": "provider",
        "source": "oc://openclaw.config/secrets/providers/vault",
        "providerSource": "env"
      },
      {
        "id": "oc://openclaw.config/models/providers/openai/apiKey",
        "kind": "input",
        "source": "oc://openclaw.config/models/providers/openai/apiKey",
        "provenance": "secretRef",
        "refSource": "env",
        "refProvider": "vault"
      }
    ],
    "authProfiles": [
      {
        "id": "github",
        "source": "oc://openclaw.config/auth/profiles/github",
        "validMetadata": true,
        "provider": "github",
        "mode": "token"
      }
    ],
    "tools": [
      {
        "id": "deploy",
        "source": "oc://AGENTS.md/tools/deploy",
        "line": 12,
        "risk": "critical",
        "sensitivity": "restricted",
        "capabilities": ["IRREVERSIBLE_EXTERNAL"]
      }
    ]
  },
  "checksRun": 30,
  "checksSkipped": 0,
  "findings": []
}
```

`attestation.policy.hash` identifies the authored rule artifact. `evidence`
records the observed OpenClaw state used by the checks, and
`workspace.hash` identifies that evidence payload. `findingsHash` identifies
the exact finding set. `checkedAt` records when the check ran.
`attestationHash` identifies the stable claim (policy hash, evidence hash,
findings hash, and clean/dirty state) and deliberately excludes `checkedAt`,
so the same policy state always produces the same attestation hash. Together
these four values form the audit tuple for one policy check.

If a gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean
check. `checkedAt` stays in JSON output for audit logs but is not part of the
stable hash.

Lifecycle for accepting policy state:

1. Author or review `policy.jsonc`.
2. Run `openclaw policy check --json`.
3. If clean, record `attestation.policy.hash` as `expectedHash`.
4. Record `attestation.attestationHash` as `expectedAttestationHash`.
5. Re-run `openclaw doctor --lint` in CI or release gates.

If policy rules change intentionally, update both accepted hashes from a
clean check. If only workspace settings change (policy stays the same),
typically only `expectedAttestationHash` changes.

Enabling or upgrading `agents.workspace` rules adds `agentWorkspace` evidence
to the workspace hash and attestation hash; review the new evidence and
refresh accepted attestation hashes after enabling. Enabling or upgrading
tool posture rules adds `toolPosture` evidence the same way.

`openclaw policy watch` re-runs the check and reports when current evidence no
longer matches `expectedAttestationHash`:

```bash
openclaw policy watch --json
openclaw policy watch --agent ops --json
```

Use `--once` in CI or scripts that need a single drift evaluation. Without
`--once`, it polls every two seconds by default; use `--interval-ms` to change
the interval.
