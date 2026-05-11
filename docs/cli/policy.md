---
summary: "CLI reference for `openclaw policy` channel conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need policy, evidence, and findings hashes for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled `policy` extension. Policy is an
enterprise conformance feature: it lets an operator express required workspace
posture in `policy.jsonc`, checks existing OpenClaw settings against those
requirements, and emits audit evidence that can be recorded.

Policy is a conformance layer over existing OpenClaw settings. It does not add
a second configuration system. `policy.jsonc` defines authored requirements,
OpenClaw observes current settings as evidence, and policy registers health
checks that report drift. The final conformance signal is a clean
`doctor --lint` run; policy contributes findings to that shared lint surface
instead of creating a separate health gate.

This first policy slice manages configured channels. For example, IT or a
workspace operator can record that Telegram is not an approved channel
provider, then use `doctor --lint` to report any enabled Telegram channel and
`doctor --fix` to turn it off when workspace repairs are explicitly enabled.

Use policy when a workspace needs a durable statement such as "these channels
must not be enabled" and a repeatable way to prove that OpenClaw still conforms
to that statement. Use regular config alone when you only need to set local
behavior and do not need policy findings or attestation output.

## Enable

Enable the bundled policy extension before first use:

```bash
openclaw plugins enable policy
```

When policy is enabled, doctor can load the policy health checks through a
bounded public API without activating arbitrary plugins. The extension remains
enabled even if `policy.jsonc` is missing, so doctor can report that the policy
artifact needs to be restored or added.

## Author Policy

Policy is authored, not generated from the user's current settings. A minimal
channel policy looks like this:

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
}
```

The rules are the authority. A category block is only a namespace; checks run
when a concrete rule is present. OpenClaw reads current `channels.*` settings
and reports settings that do not conform.

## Commands

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits the observed workspace
evidence plus policy, evidence, findings, and attestation hashes. The same
findings also appear in `openclaw doctor --lint` when the policy extension is
enabled, and `doctor --lint` is the workspace-level gate.

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
    ]
  },
  "checksRun": 3,
  "checksSkipped": 0,
  "findings": []
}
```

The policy hash identifies the authored rule artifact. The evidence block
records the observed OpenClaw state used by the policy checks. The
`workspace.hash` value identifies that evidence payload for the checked scope.
The findings hash identifies the exact finding set returned by the check.
`checkedAt` records when the evaluation ran. The attestation hash identifies
the whole claim, including the timestamp and whether the result was clean.
Together, these form the audit tuple for this policy check.

If a later gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean policy
check. That single value binds the policy file, observed evidence, findings,
and check time used to justify the decision.

Policy findings can include both `target` and `requirement`. `target` is the
observed workspace thing that does not conform. `requirement` is the authored
policy rule that made it a finding. Both values are addresses today, usually
`oc://` paths, but the field names describe their policy role rather than the
address format.

## Configuration

Policy config lives under `plugins.entries.policy.config`:

```jsonc
{
  "plugins": {
    "entries": {
      "policy": {
        "enabled": true,
        "config": {
          "enabled": true,
          "workspaceRepairs": false,
          "expectedHash": "sha256:...",
          "path": "policy.jsonc",
        },
      },
    },
  },
}
```

| Setting            | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `enabled`          | Enable policy checks even before `policy.jsonc` exists.         |
| `workspaceRepairs` | Allow `doctor --fix` to edit policy-managed workspace settings. |
| `expectedHash`     | Optional hash-lock for the approved policy artifact.            |
| `path`             | Workspace-relative location of the policy artifact.             |

Set `plugins.entries.policy.config.enabled` to `false` to disable policy
checks for a workspace.

## Checks

Policy currently verifies:

| Check id                          | Finding                                          |
| --------------------------------- | ------------------------------------------------ |
| `policy/policy-jsonc-missing`     | Policy is enabled but `policy.jsonc` is missing. |
| `policy/policy-jsonc-invalid`     | Policy cannot be parsed or has malformed rules.  |
| `policy/policy-hash-mismatch`     | Policy does not match configured `expectedHash`. |
| `policy/channels-denied-provider` | An enabled channel matches a channel deny rule.  |

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

## Repair

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled. Without that opt-in, policy checks
report what they would repair and leave settings unchanged.

In this version, repair can disable channels that are enabled in OpenClaw config
but denied by `channels.denyRules`.

## Exit Codes

| Command        | `0`                           | `1`                                     | `2`                          |
| -------------- | ----------------------------- | --------------------------------------- | ---------------------------- |
| `policy check` | No findings at the threshold. | One or more findings met the threshold. | Argument or runtime failure. |

## Related

- [Doctor lint mode](/cli/doctor#lint-mode)
- [Policy plugin reference](/plugins/reference/policy)
- [Path CLI](/cli/path)
