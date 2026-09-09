---
summary: "CLI reference for `openclaw policy` conformance checks"
read_when:
  - You want to check OpenClaw settings against an authored policy.jsonc
  - You want policy findings in doctor lint
  - You need a policy attestation hash for audit evidence
title: "Policy"
---

# `openclaw policy`

`openclaw policy` is provided by the bundled Policy plugin. It is an enterprise
conformance layer over existing OpenClaw settings, not a second configuration
system. You author requirements in `policy.jsonc`; OpenClaw observes the active
workspace as evidence; policy reports drift through `doctor --lint`. Policy
does not enforce tool calls or rewrite runtime behavior at request time, and it
does not attest per-agent credential stores such as `openclaw-agent.sqlite`.

Policy checks configured channels, MCP servers, model providers, network SSRF
posture, ingress/channel access, Gateway exposure and node command posture,
authored message-routing probes,
agent workspace access, sandbox posture, data-handling posture, secret
provider/auth profile posture, and governed tool metadata (the `## Tools` section of `AGENTS.md`). Use it
when a workspace needs a durable, checkable statement such as "Telegram must
not be enabled" or "governed tools must declare risk and owner metadata." If
you only need local behavior with no attestation or drift detection, plain
config is enough.

Separately, [`openclaw agent exec`](/cli/agent#agent-exec) applies an isolated
implicit policy config for each run: the agent sandbox is off, Gateway-host
execution is fully allowed, and filesystem tools are restricted to `--cwd`.

## Detailed topics

<CardGroup cols={3}>
  <Card title="Author a policy file" href="/cli/policy/authoring" icon="pen">
    Enable the plugin and write `policy.jsonc`, with an example covering every section.
  </Card>
  <Card title="Policy rule reference" href="/cli/policy/rules" icon="table-list">
    Every rule namespace, the OpenClaw state it observes, and when to use it.
  </Card>
  <Card title="Scoped overlays" href="/cli/policy/scopes" icon="layer-group">
    Hold named agents or channels to stricter rules than the baseline.
  </Card>
  <Card title="Run checks" href="/cli/policy/running-checks" icon="play">
    `policy check`, `policy compare`, and the plugin config behind them.
  </Card>
  <Card title="Accept policy state" href="/cli/policy/attestation" icon="stamp">
    Evidence, attestation hashes, and `policy watch` drift detection.
  </Card>
  <Card title="Findings and repair" href="/cli/policy/findings" icon="list-check">
    Every check id, what `doctor --fix` repairs, and exit codes.
  </Card>
</CardGroup>

- <a id="quick-start"></a>[Quick start](/cli/policy/authoring#quick-start)
  - <a id="policy-rule-reference"></a>[Policy rule reference](/cli/policy/rules#policy-rule-reference)
    - <a id="scoped-overlays"></a>[Scoped overlays](/cli/policy/scopes#scoped-overlays)
    - <a id="channels"></a>[Channels](/cli/policy/rules#channels)
    - <a id="mcp-servers"></a>[MCP servers](/cli/policy/rules#mcp-servers)
    - <a id="model-providers"></a>[Model providers](/cli/policy/rules#model-providers)
    - <a id="network"></a>[Network](/cli/policy/rules#network)
    - <a id="message-routing"></a>[Message routing](/cli/policy/rules#message-routing)
    - <a id="ingress-and-channel-access"></a>[Ingress and channel access](/cli/policy/rules#ingress-and-channel-access)
    - <a id="gateway"></a>[Gateway](/cli/policy/rules#gateway)
    - <a id="agent-workspace"></a>[Agent workspace](/cli/policy/rules#agent-workspace)
    - <a id="sandbox-posture"></a>[Sandbox posture](/cli/policy/rules#sandbox-posture)
    - <a id="data-handling"></a>[Data Handling](/cli/policy/rules#data-handling)
    - <a id="secrets"></a>[Secrets](/cli/policy/rules#secrets)
    - <a id="exec-approvals"></a>[Exec approvals](/cli/policy/rules#exec-approvals)
    - <a id="auth-profiles"></a>[Auth profiles](/cli/policy/rules#auth-profiles)
    - <a id="tool-metadata"></a>[Tool metadata](/cli/policy/rules#tool-metadata)
    - <a id="tool-posture"></a>[Tool posture](/cli/policy/rules#tool-posture)
- <a id="run-checks"></a>[Run checks](/cli/policy/running-checks#run-checks)
- <a id="configure-policy"></a>[Configure policy](/cli/policy/running-checks#configure-policy)
- <a id="accept-policy-state"></a>[Accept policy state](/cli/policy/attestation#accept-policy-state)
- <a id="findings"></a>[Findings](/cli/policy/findings#findings)
- <a id="repair"></a>[Repair](/cli/policy/findings#repair)
- <a id="exit-codes"></a>[Exit codes](/cli/policy/findings#exit-codes)

## Related

- [Doctor lint mode](/cli/doctor#lint-mode)
- [Path CLI](/cli/path)
