---
summary: "Policy-backed doctor checks for workspace conformance."
read_when:
  - You are installing, configuring, or auditing the policy plugin
title: "Policy plugin"
---

# Policy plugin

Policy-backed doctor checks for workspace conformance.

## Distribution

- Package: `@openclaw/policy`
- Install route: included in OpenClaw

## Surface

plugin; CLI command: [`openclaw policy`](/cli/policy)

## Behavior

The Policy plugin contributes doctor health checks for policy-managed OpenClaw
settings and governed workspace declarations. Policy currently covers channel
conformance, governed tool metadata, MCP server posture, model-provider posture,
private-network access posture, runtime channel audit, and accepted-attestation
runtime audit.

Policy stores authored requirements in `policy.jsonc`, observes existing
OpenClaw settings and workspace declarations as evidence, and reports drift
through `openclaw policy check` and `openclaw doctor --lint`. A clean policy
check emits policy, evidence, findings, and attestation hashes that operators
can record for audit. `checkedAt` is audit metadata and is excluded from the
stable attestation hash.

When `runtimeToolPolicy` is enabled, the Policy plugin registers a trusted tool
policy that blocks unverifiable governed tool calls and requests approval for
critical or irreversible governed tools. If `expectedAttestationHash` is
configured, the same gate fails closed when current policy evidence no longer
matches the accepted clean policy check.

## Related docs

- [Policy CLI](/cli/policy)
- [Doctor lint mode](/cli/doctor#lint-mode)
