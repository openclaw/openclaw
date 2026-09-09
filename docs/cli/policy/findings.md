---
summary: "Every policy check id, what `doctor --fix` will and will not repair, and command exit codes"
read_when:
  - You want to look up what a `policy/...` finding means
  - You want to know which findings `doctor --fix` can repair automatically
  - You are scripting against policy command exit codes
title: "Policy findings, repair, and exit codes"
sidebarTitle: "Findings and repair"
---

Interpreting a policy finding, repairing it, and the exit codes. Part of the [`openclaw policy`](/cli/policy) reference.

## Findings

| Check id                                                 | Finding                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `policy/policy-jsonc-missing`                            | Policy is enabled but `policy.jsonc` is missing.                                  |
| `policy/policy-jsonc-invalid`                            | Policy cannot be parsed or contains malformed rule entries.                       |
| `policy/policy-hash-mismatch`                            | Policy does not match configured `expectedHash`.                                  |
| `policy/attestation-hash-mismatch`                       | Current policy evidence no longer matches the accepted attestation.               |
| `policy/policy-conformance-invalid`                      | A baseline or checked policy file has invalid comparison syntax.                  |
| `policy/policy-conformance-missing`                      | A checked policy file is missing a rule required by the baseline policy file.     |
| `policy/policy-conformance-weaker`                       | A checked policy file has a weaker value than the baseline policy file.           |
| `policy/channels-denied-provider`                        | An enabled channel matches a channel deny rule.                                   |
| `policy/mcp-denied-server`                               | A configured MCP server is denied by policy.                                      |
| `policy/mcp-unapproved-server`                           | A configured MCP server is outside the allowlist.                                 |
| `policy/models-denied-provider`                          | A configured model provider or model ref uses a denied provider.                  |
| `policy/models-unapproved-provider`                      | A configured model provider or model ref is outside the allowlist.                |
| `policy/network-private-access-enabled`                  | A private-network SSRF escape hatch is enabled when policy denies it.             |
| `policy/routing-bindings-required`                       | Policy requires a channel route binding, but none is configured.                  |
| `policy/routing-binding-channel-unconfigured`            | A route binding names a channel absent from `channels.*`.                         |
| `policy/routing-agent-mismatch`                          | An authored route resolves to a different agent.                                  |
| `policy/routing-match-kind-mismatch`                     | An authored route matches at an unexpected binding specificity.                   |
| `policy/ingress-dm-policy-unapproved`                    | A channel DM policy is outside the policy allowlist.                              |
| `policy/ingress-dm-scope-unapproved`                     | `session.dmScope` does not match the policy-required DM isolation scope.          |
| `policy/ingress-open-groups-denied`                      | A channel group policy is `open` while policy denies open group ingress.          |
| `policy/ingress-group-mention-required`                  | A channel or group entry disables mention gates while policy requires them.       |
| `policy/gateway-non-loopback-bind`                       | Gateway bind posture permits non-loopback exposure when policy denies it.         |
| `policy/gateway-auth-disabled`                           | Gateway authentication is disabled when policy requires auth.                     |
| `policy/gateway-rate-limit-missing`                      | Gateway auth rate-limit posture is not explicit when policy requires it.          |
| `policy/gateway-control-ui-insecure`                     | Gateway Control UI insecure exposure toggles are enabled.                         |
| `policy/gateway-tailscale-funnel`                        | Gateway Tailscale Funnel exposure is enabled when policy denies it.               |
| `policy/gateway-remote-enabled`                          | Gateway remote mode is active when policy denies it.                              |
| `policy/gateway-http-endpoint-enabled`                   | A Gateway HTTP API endpoint is enabled while denied by policy.                    |
| `policy/gateway-http-url-fetch-unrestricted`             | Gateway HTTP URL-fetch input lacks a required URL allowlist.                      |
| `policy/gateway-node-command-denied`                     | A node command denied by policy is not denied by OpenClaw config.                 |
| `policy/agents-workspace-access-denied`                  | Agent sandbox mode or workspace access is outside the policy allowlist.           |
| `policy/agents-tool-not-denied`                          | An agent or default config does not deny a tool required by policy.               |
| `policy/tools-profile-unapproved`                        | A configured global or per-agent tool profile is outside the allowlist.           |
| `policy/tools-fs-workspace-only-required`                | Filesystem tools are not configured with workspace-only path posture.             |
| `policy/tools-exec-security-unapproved`                  | Exec security mode is outside the policy allowlist.                               |
| `policy/tools-exec-ask-unapproved`                       | Exec ask mode is outside the policy allowlist.                                    |
| `policy/tools-exec-host-unapproved`                      | Exec host routing is outside the policy allowlist.                                |
| `policy/tools-elevated-enabled`                          | Elevated tool mode is enabled when policy denies it.                              |
| `policy/tools-also-allow-missing`                        | A configured `alsoAllow` list is missing an entry required by policy.             |
| `policy/tools-also-allow-unexpected`                     | A configured `alsoAllow` list includes an entry not expected by policy.           |
| `policy/tools-required-deny-missing`                     | A global or per-agent tool deny list does not include a required denied tool.     |
| `policy/sandbox-mode-unapproved`                         | Sandbox mode is outside the policy allowlist.                                     |
| `policy/sandbox-backend-unapproved`                      | Sandbox backend is outside the policy allowlist.                                  |
| `policy/sandbox-container-posture-unobservable`          | A container posture rule is enabled for a backend that cannot observe it.         |
| `policy/sandbox-container-host-network-denied`           | A container-backed sandbox or browser uses host network mode.                     |
| `policy/sandbox-container-namespace-join-denied`         | A container-backed sandbox or browser joins another container namespace.          |
| `policy/sandbox-container-mount-mode-required`           | A container-backed sandbox or browser mount is not read-only.                     |
| `policy/sandbox-container-runtime-socket-mount`          | A container-backed sandbox or browser mount exposes the container runtime socket. |
| `policy/sandbox-container-unconfined-profile`            | Container sandbox profile is unconfined when policy denies it.                    |
| `policy/sandbox-browser-cdp-source-range-missing`        | Sandbox browser CDP source range is missing when policy requires one.             |
| `policy/data-handling-telemetry-content-capture`         | Telemetry content capture is enabled when policy denies it.                       |
| `policy/data-handling-session-retention-not-enforced`    | Session retention maintenance is not enforced when policy requires it.            |
| `policy/data-handling-session-transcript-memory-enabled` | Session transcript memory indexing is enabled when policy denies it.              |
| `policy/secrets-unmanaged-provider`                      | A config SecretRef references a provider not declared under `secrets.providers`.  |
| `policy/secrets-denied-provider-source`                  | A config secret provider or SecretRef uses a source denied by policy.             |
| `policy/secrets-insecure-provider`                       | A secret provider opts into insecure posture when policy denies it.               |
| `policy/auth-profile-invalid-metadata`                   | A config auth profile is missing valid provider or mode metadata.                 |
| `policy/auth-profile-unapproved-mode`                    | A config auth profile mode is outside the policy allowlist.                       |
| `policy/exec-approvals-missing`                          | Policy requires the SQLite exec approvals document, but its row is missing.       |
| `policy/exec-approvals-invalid`                          | The configured SQLite exec approvals document cannot be parsed.                   |
| `policy/exec-approvals-default-security-unapproved`      | Exec approval defaults use a security mode outside the policy allowlist.          |
| `policy/exec-approvals-agent-security-unapproved`        | A per-agent effective exec approval security mode is outside the allowlist.       |
| `policy/exec-approvals-auto-allow-skills-enabled`        | An exec approval agent implicitly auto-allows skill CLIs when policy denies it.   |
| `policy/exec-approvals-allowlist-missing`                | The approvals allowlist is missing a pattern required by policy.                  |
| `policy/exec-approvals-allowlist-unexpected`             | The approvals allowlist includes a pattern not expected by policy.                |
| `policy/tools-missing-risk-level`                        | A governed tool declaration is missing risk metadata.                             |
| `policy/tools-unknown-risk-level`                        | A governed tool declaration uses an unknown risk value.                           |
| `policy/tools-missing-sensitivity-token`                 | A governed tool declaration is missing sensitivity metadata.                      |
| `policy/tools-missing-owner`                             | A governed tool declaration is missing owner metadata.                            |
| `policy/tools-unknown-sensitivity-token`                 | A governed tool declaration uses an unknown sensitivity value.                    |

A finding can include both `target` (the observed workspace thing that does
not conform) and `requirement` (the authored rule that made it a finding).
Both are `oc://` address strings today, but the field names describe policy
role rather than address format.

Example findings:

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

```json
{
  "checkId": "policy/tools-missing-risk-level",
  "severity": "error",
  "message": "AGENTS.md tool 'deploy' has no explicit risk classification.",
  "source": "policy",
  "path": "AGENTS.md",
  "line": 12,
  "ocPath": "oc://AGENTS.md/tools/deploy",
  "target": "oc://AGENTS.md/tools/deploy",
  "requirement": "oc://policy.jsonc/tools/requireMetadata"
}
```

```json
{
  "checkId": "policy/mcp-unapproved-server",
  "severity": "error",
  "message": "MCP server 'remote' is not in the policy allowlist.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/mcp/servers/remote",
  "target": "oc://openclaw.config/mcp/servers/remote",
  "requirement": "oc://policy.jsonc/mcp/servers/allow"
}
```

```json
{
  "checkId": "policy/models-unapproved-provider",
  "severity": "error",
  "message": "Model ref 'anthropic/claude-sonnet-4.7' uses unapproved provider 'anthropic'.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "target": "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  "requirement": "oc://policy.jsonc/models/providers/allow"
}
```

```json
{
  "checkId": "policy/network-private-access-enabled",
  "severity": "error",
  "message": "Network setting 'browser-private-network' allows private-network access.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  "target": "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  "requirement": "oc://policy.jsonc/network/privateNetwork/allow"
}
```

```json
{
  "checkId": "policy/gateway-non-loopback-bind",
  "severity": "error",
  "message": "Gateway bind setting 'gateway-bind' permits non-loopback exposure.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/gateway/bind",
  "target": "oc://openclaw.config/gateway/bind",
  "requirement": "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind"
}
```

```json
{
  "checkId": "policy/gateway-node-command-denied",
  "severity": "error",
  "message": "Gateway node command 'system.run' is denied by policy but not denied by OpenClaw config.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/gateway/nodes/commands/deny",
  "target": "oc://openclaw.config/gateway/nodes/commands/deny",
  "requirement": "oc://policy.jsonc/gateway/nodes/denyCommands",
  "fixHint": "Add 'system.run' to gateway.nodes.commands.deny or update policy after review."
}
```

```json
{
  "checkId": "policy/agents-workspace-access-denied",
  "severity": "error",
  "message": "agents.defaults sandbox workspaceAccess 'rw' is not allowed by policy.",
  "source": "policy",
  "path": "openclaw config",
  "ocPath": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
  "target": "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
  "requirement": "oc://policy.jsonc/agents/workspace/allowedAccess"
}
```

## Repair

`doctor --lint` and `policy check` are read-only.

`doctor --fix` only edits policy-managed workspace settings when
`workspaceRepairs` is explicitly enabled; otherwise checks report what they
would repair and leave settings unchanged.

In this version, repair can disable channels denied by `channels.denyRules` and
apply the automatic narrowing repairs listed below. Enable `workspaceRepairs`
only after the policy file has been reviewed, because a valid rule can change
workspace config:

- set `tools.elevated.enabled=false` when a global policy forbids elevated tools
- add missing required-deny tool ids to `tools.deny` or
  `agents.entries.*.tools.deny` when policy requires those tools to be denied
- set insecure `gateway.controlUi.*` toggles to `false`
- set `gateway.mode=local` when policy denies remote gateway mode
- set reported `gateway.http.endpoints.*.enabled` paths to `false` when policy
  denies Gateway HTTP API endpoints
- set reported channel ingress `groupPolicy` paths to `allowlist` when policy
  denies open group ingress
- set reported channel ingress `requireMention` paths to `true` when policy
  requires group mentions
- set `diagnostics.otel.captureContent=false`, or
  `diagnostics.otel.captureContent.enabled=false` for object-form telemetry
  capture settings, when policy denies telemetry content capture

Scoped elevated-tools repairs are detect-only. Scoped data-handling repairs are
also skipped when the finding reports shared telemetry config, because changing
the shared setting would affect more than the scoped policy target.

`dataHandling.sensitiveLogging.requireRedaction` has no check and no repair.
Sensitive log redaction is unconditional in OpenClaw, so nothing can report it
as disabled. The key stays a supported policy rule: `openclaw policy` validates
its shape, `openclaw policy compare` still requires a candidate policy to be at
least as strict as the baseline for it, and `openclaw policy check` records the
runtime invariant `oc://openclaw.invariant/logging/redaction` in the
`dataHandling` evidence and attestation as proof the requirement is satisfied.

Scoped required-deny repairs are skipped when the finding reports inherited
root `tools.deny`, because adding the required tool to root config would affect
more than the scoped policy target. Agent-local required-deny repairs can update
the reported `agents.entries.*.tools.deny` path.

Scoped channel ingress repairs are skipped when the finding reports inherited
`channels.defaults.*`, because changing the shared channel default would affect
more than the scoped policy target. Gateway HTTP URL-fetch allowlist findings
remain manual because automatic repair cannot choose the correct endpoint URL
allowlist values.

Gateway bind and node-command findings stay review-required. When
`policy/gateway-non-loopback-bind` or `policy/gateway-node-command-denied`
can be mapped to a config path, `doctor --fix` reports the proposed
`gateway.bind` or `gateway.nodes.commands.deny` change as skipped preview
guidance. It does not apply the change, and the finding does not count as
repaired until an operator reviews and updates config or policy.

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

| Command          | `0`                                                    | `1`                                                                 | `2`                          |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| `policy check`   | No findings at the threshold.                          | One or more findings met the threshold.                             | Argument or runtime failure. |
| `policy compare` | The policy file is at least as strict as the baseline. | The policy file is invalid, missing, or weaker than baseline rules. | Argument or runtime failure. |
| `policy watch`   | No findings and accepted hash is current.              | Findings exist or accepted attestation is stale.                    | Argument or runtime failure. |
