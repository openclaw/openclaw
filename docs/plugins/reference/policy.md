---
summary: "Adds policy-backed doctor checks for workspace conformance."
read_when:
  - You are installing, configuring, or auditing the policy plugin
title: "Policy plugin"
---

# Policy plugin

Adds policy-backed doctor checks for workspace conformance.

## Distribution

- Package: `@openclaw/policy`
- Install route: included in OpenClaw

## Surface

plugin

## Behavior

The Policy plugin contributes doctor health checks for policy-managed OpenClaw
settings and governed workspace declarations. Policy currently covers channel
conformance, governed tool metadata, MCP server posture, model-provider posture,
private-network access posture, Gateway exposure posture, agent workspace/tool
posture, configured global/per-agent tool posture, and OpenClaw config secret
provider/auth profile posture.

Policy stores authored requirements in `policy.jsonc`, observes existing
OpenClaw settings and workspace declarations as evidence, and reports drift
through `openclaw policy check` and `openclaw doctor --lint`. A clean policy
check emits policy, evidence, findings, and attestation hashes that operators
can record for audit.

Tool posture rules can require approved profiles, workspace-only filesystem
tools, bounded exec security/ask/host settings, disabled elevated mode, exact
`alsoAllow` entries, and required tool deny entries. The evidence records
additive `alsoAllow` entries because they can widen effective tool posture.
These checks observe config conformance only; they do not read runtime approval
state or add runtime enforcement.

Named agent policy scopes under `scopes.<scopeName>` can add stricter
normal policy sections for the runtime agent ids listed in `agentIds`. The
initial scoped sections are `tools` and `agents.workspace`; future sections such
as sandbox or ingress can join the same container after their evidence carries
agent identity. Every scope present in `policy.jsonc` must be valid and
enforceable for its selector. Overlay rules are additional claims, so they do
not weaken top-level policy and can produce their own findings when the same
observed config violates both scopes. Runtime agent ids that are not explicitly
listed in `agents.list[]` are checked against inherited global/default posture
rather than silently passing with no evidence.

## Related docs

- [policy](/cli/policy)
