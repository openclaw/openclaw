---
summary: "Policy-backed doctor checks for workspace conformance."
read_when:
  - You are installing, configuring, or auditing the policy plugin
title: "Policy plugin"
---

# Policy plugin

Policy-backed doctor checks for workspace conformance. Policy is an enterprise
conformance feature: `policy.jsonc` records authored requirements, existing
OpenClaw settings are observed as evidence, and policy checks produce findings
plus attestation hashes that can be recorded for audit.

## Distribution

- Package: `@openclaw/policy`
- Install route: included in OpenClaw

## Surface

plugin; CLI command: [`openclaw policy`](/cli/policy)

## Behavior

The policy plugin contributes doctor health checks for policy-managed OpenClaw
settings. The base model is intentionally small:

- `policy.jsonc` stores operator-owned requirements.
- Existing OpenClaw settings are observed as evidence; policy does not create a
  second configuration system.
- Policy registers health checks, so `policy check`, `doctor --lint`, and
  `doctor --fix` all use the same findings and repair path.
- A clean policy check emits policy/evidence/findings/attestation hashes that
  can be recorded for audit.

This first version applies that model to channel conformance:

- `policy.jsonc` stores channel deny requirements.
- `openclaw policy check` runs only the policy health checks and emits
  observed channel evidence plus policy/evidence/findings/attestation hashes.
- `openclaw doctor --lint` reports the same policy findings alongside other
  structured health checks.
- `openclaw doctor --fix` can disable denied enabled channels when
  `workspaceRepairs` is explicitly enabled.

Policy is not a duplicate governance stack. It records expected conformance in
`policy.jsonc`, reports missing, hash-mismatched, or denied settings through
doctor, and repairs existing OpenClaw config through the same config repair
model. The final conformance signal remains a clean `doctor --lint` run; policy
adds domain-specific findings to that shared health surface.

Policy findings identify both sides of the decision when available: `target`
points to the observed workspace thing, and `requirement` points to the
authored policy rule. The current addresses are `oc://` paths, but the fields
are named for their policy roles rather than the address format.

Use policy when operators need to prove that a workspace still conforms to an
approved requirement, such as a denied channel provider. Use ordinary OpenClaw
config when the workspace only needs local behavior and does not need policy
findings or attestation output.

The policy hash identifies the authored requirement file. The evidence hash
identifies the observed OpenClaw state used by the policy checks. The findings
hash identifies the exact finding set. The attestation hash binds those values
with the check result and timestamp, giving operators a compact value to record
when a workspace is clean.

When policy is enabled, doctor loads the policy health checks through the
extension public API. That keeps lint and repair plugin-free while still
letting bundled extensions contribute bounded health checks.

## Config

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

`workspaceRepairs` defaults to off. With the default posture, policy checks can
report denied channels, but `doctor --fix` will not edit workspace settings for
policy unless the operator explicitly enables repairs. `expectedHash` can pin
the policy file to an approved hash.

## Checks

The plugin registers these doctor health checks:

| Check id                          | Purpose                                      |
| --------------------------------- | -------------------------------------------- |
| `policy/policy-jsonc-missing`     | Report missing policy artifact when enabled. |
| `policy/policy-hash-mismatch`     | Reject policy files that do not match hash.  |
| `policy/channels-denied-provider` | Reject enabled channels matching deny rules. |

Run them through either surface:

```bash
openclaw policy check --json
openclaw doctor --lint --only policy/channels-denied-provider --json
```

## Related docs

- [Policy CLI](/cli/policy)
- [Doctor lint mode](/cli/doctor#lint-mode)
