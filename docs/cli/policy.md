---
summary: "CLI reference for `openclaw policy` channel conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need a policy attestation hash for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled `policy` extension. Policy is an
enterprise conformance layer over existing OpenClaw settings: `policy.jsonc`
defines authored requirements, OpenClaw observes current settings as evidence,
and policy registers health checks that report drift through `doctor --lint`.

This first policy slice manages configured channels. For example, IT can record
that Telegram is not approved, then `doctor --lint` reports any enabled Telegram
channel and `doctor --fix` can turn it off when workspace repairs are explicitly
enabled.

Enable the bundled policy extension before first use:

```bash
openclaw plugins enable policy
```

When policy is enabled, doctor can load policy health checks without activating
arbitrary plugins. The extension remains enabled if `policy.jsonc` is missing,
so doctor can report the missing artifact.

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

```bash
openclaw policy check
openclaw policy check --json
openclaw policy check --severity-min error
```

`policy check` runs only the policy check set and emits evidence, findings, and
attestation hashes. The same findings also appear in `openclaw doctor --lint`
when the policy extension is enabled.

The attestation hash identifies the stable claim: policy hash, evidence hash,
findings hash, and whether the result was clean. It intentionally does not
include `checkedAt`, so the same policy state produces the same attestation
across repeated checks.

If a later gateway or supervisor uses policy to block, approve, or annotate a
runtime action, it should record the attestation hash from the last clean policy
check. `checkedAt` stays in JSON output for audit logs, but is not part of the
stable attestation hash.

Policy findings can include `target` and `requirement`: the observed workspace
thing that does not conform, and the authored rule that made it a finding.

Policy config lives under `plugins.entries.policy.config`.

| Setting                   | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `enabled`                 | Enable policy checks even before `policy.jsonc` exists.         |
| `workspaceRepairs`        | Allow `doctor --fix` to edit policy-managed workspace settings. |
| `expectedHash`            | Optional hash-lock for the approved policy artifact.            |
| `expectedAttestationHash` | Optional hash-lock for the last accepted clean policy check.    |
| `path`                    | Workspace-relative location of the policy artifact.             |

Set `plugins.entries.policy.config.enabled` to `false` to disable policy
checks for a workspace.

Policy currently verifies:

| Check id                           | Finding                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `policy/policy-jsonc-missing`      | Policy is enabled but `policy.jsonc` is missing.                    |
| `policy/policy-jsonc-invalid`      | Policy cannot be parsed or has malformed rules.                     |
| `policy/policy-hash-mismatch`      | Policy does not match configured `expectedHash`.                    |
| `policy/attestation-hash-mismatch` | Current policy evidence no longer matches the accepted attestation. |
| `policy/channels-denied-provider`  | An enabled channel matches a channel deny rule.                     |

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled. Without that opt-in, policy checks
report what they would repair and leave settings unchanged.

In this version, repair can disable channels that are enabled in OpenClaw config
but denied by `channels.denyRules`.

`policy check` exits `0` when there are no findings at the threshold, `1` when
findings are present, and `2` for argument or runtime failures.
