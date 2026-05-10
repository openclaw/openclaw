---
summary: "CLI reference for `openclaw policy` conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need a policy attestation hash for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled Policy plugin. Policy is an
enterprise conformance layer over existing OpenClaw settings. It does not add a
second configuration system. `policy.jsonc` defines authored requirements,
OpenClaw observes the active workspace as evidence, and policy health checks
report drift through `doctor --lint`. The final conformance signal is a clean
`doctor --lint` run; policy contributes findings to that shared lint surface
instead of creating a separate health gate.

Policy currently manages configured channels and governed tool declarations.
For example, IT or a workspace operator can record that Telegram is not an
approved channel provider, require governed tools to carry risk and sensitivity
metadata, then use `doctor --lint` as the shared conformance gate.

Use policy when a workspace needs a durable statement such as "these channels
must not be enabled" or "governed tools must declare approval metadata" and a
repeatable way to prove that OpenClaw still conforms to that statement. Use
regular config and workspace docs alone when you only need local behavior and
do not need policy findings or attestation output.

## Quick start

Enable the bundled Policy plugin before first use:

```bash
openclaw plugins enable policy
```

When policy is enabled, doctor can load policy health checks without activating
arbitrary plugins. The plugin remains enabled if `policy.jsonc` is missing, so
doctor can report the missing artifact.

Policy is authored, not generated from the user's current settings. A minimal
policy for channels and tool metadata looks like this:

```jsonc
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
  "tools": {
    "settings": {
      "requireRisk": true,
      "requireSensitivity": true,
    },
  },
}
```

The rules are the authority. A category block is only a namespace; checks run
when a concrete rule is present. OpenClaw reads current `channels.*` settings
and `TOOLS.md` declarations as evidence, then reports observed state that does
not conform.

Run policy-only checks during authoring:

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits evidence, findings, and
attestation hashes. The same findings also appear in `openclaw doctor --lint`
when the Policy plugin is enabled.

Example clean JSON output includes stable hashes that can be recorded by an
operator or supervisor:

```json
{
  "ok": true,
  "attestation": {
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
  "checksRun": 5,
  "checksSkipped": 0,
  "findings": []
}
```

## Configure policy

Policy config lives under `plugins.entries.policy.config`.

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "enabled": true,
        "config": {
          "enabled": true,
          "path": "policy.jsonc",
          "requireRisk": true,
          "requireSensitivity": true,
          "workspaceRepairs": false,
          "expectedHash": "sha256:...",
          "expectedAttestationHash": "sha256:...",
        },
      },
    },
  },
}
```

| Setting                   | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `enabled`                 | Enable policy checks even before `policy.jsonc` exists.             |
| `requireRisk`             | Require governed tool declarations to include risk metadata.        |
| `requireSensitivity`      | Require governed tool declarations to include sensitivity metadata. |
| `workspaceRepairs`        | Allow `doctor --fix` to edit policy-managed workspace settings.     |
| `expectedHash`            | Optional hash-lock for the approved policy artifact.                |
| `expectedAttestationHash` | Optional hash-lock for the last accepted clean policy check.        |
| `path`                    | Workspace-relative location of the policy artifact.                 |

Set `plugins.entries.policy.config.enabled` to `false` to disable policy checks
for a workspace while leaving the plugin installed.

Tool requirement booleans can also live under `tools.settings` in
`policy.jsonc`. Config wins when both places set the same value.

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
    "tools": [
      {
        "id": "deploy",
        "ocPath": "oc://TOOLS.md/tools/deploy",
        "line": 12,
        "risk": "critical",
        "sensitivity": "restricted",
        "capabilities": ["IRREVERSIBLE_EXTERNAL"]
      }
    ]
  },
  "checksRun": 6,
  "checksSkipped": 0,
  "findings": []
}
```

The policy hash identifies the authored rule artifact. The evidence block
records the observed OpenClaw state used by the policy checks. The
`workspace.hash` value identifies that evidence payload for the checked scope.
The findings hash identifies the exact finding set returned by the check.
`checkedAt` records when the evaluation ran. The attestation hash identifies
the stable claim: policy hash, evidence hash, findings hash, and whether the
result was clean. It intentionally does not include `checkedAt`, so the same
policy state produces the same attestation across repeated checks. Together,
these form the audit tuple for this policy check.

If a later gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean policy
check. `checkedAt` stays in JSON output for audit logs, but is not part of the
stable attestation hash.

Use this lifecycle when accepting policy state:

1. Author or review `policy.jsonc`.
2. Run `openclaw policy check --json`.
3. If the result is clean, record `attestation.policy.hash` as `expectedHash`.
4. Record `attestation.attestationHash` as `expectedAttestationHash`.
5. Re-run `openclaw doctor --lint` in CI or release gates.

If policy rules change intentionally, update both accepted hashes from a clean
check. If workspace settings change intentionally but policy stays the same,
only `expectedAttestationHash` usually changes.

## Findings

Policy currently verifies:

| Check id                                 | Finding                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `policy/policy-jsonc-missing`            | Policy is enabled but `policy.jsonc` is missing.                    |
| `policy/policy-jsonc-invalid`            | Policy cannot be parsed or has malformed rules.                     |
| `policy/policy-hash-mismatch`            | Policy does not match configured `expectedHash`.                    |
| `policy/attestation-hash-mismatch`       | Current policy evidence no longer matches the accepted attestation. |
| `policy/channels-denied-provider`        | An enabled channel matches a channel deny rule.                     |
| `policy/tools-missing-risk-level`        | A governed tool declaration is missing risk metadata.               |
| `policy/tools-missing-sensitivity-token` | A governed tool declaration is missing sensitivity metadata.        |
| `policy/tools-unknown-sensitivity-token` | A governed tool declaration uses an unknown sensitivity value.      |

Example JSON finding:

```json
{
  "checkId": "policy/channels-denied-provider",
  "severity": "error",
  "message": "Channel 'telegram' uses denied provider 'telegram'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/channels/telegram",
  "target": "oc://openclaw.config/channels/telegram",
  "requirement": "oc://policy.jsonc/channels/denyRules/#0",
  "fixHint": "Telegram is not approved for this workspace."
}
```

Example tool finding:

```json
{
  "checkId": "policy/tools-missing-risk-level",
  "severity": "error",
  "message": "TOOLS.md tool 'deploy' has no explicit risk classification.",
  "source": "policy",
  "path": "TOOLS.md",
  "line": 12,
  "ocPath": "oc://TOOLS.md/tools/deploy",
  "target": "oc://TOOLS.md/tools/deploy",
  "requirement": "oc://policy.jsonc/tools/settings/requireRisk"
}
```

## Repair

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled. Without that opt-in, policy checks
report what they would repair and leave settings unchanged.

In this version, repair can disable channels that are enabled in OpenClaw config
but denied by `channels.denyRules`. Enable `workspaceRepairs` only after the
policy file has been reviewed, because a valid deny rule can turn off a
configured channel:

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "config": {
          "workspaceRepairs": true,
        },
      },
    },
  },
}
```

## Exit codes

`policy check` exits `0` when there are no findings at the threshold, `1` when
findings are present, and `2` for argument or runtime failures.
