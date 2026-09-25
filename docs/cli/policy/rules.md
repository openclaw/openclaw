---
summary: "Every supported `policy.jsonc` rule, the OpenClaw state it observes, and when to use it"
read_when:
  - You need the observed state behind a specific policy rule
  - You want to scope stricter policy at named agents or channels
  - You are choosing between channel, gateway, sandbox, secrets, or tool rules
title: "Policy rule reference"
sidebarTitle: "Rule reference"
---

Every supported rule namespace, field by field. Part of the [`openclaw policy`](/cli/policy) reference.

## Policy rule reference

Every rule below is optional; a check runs only when the rule is present. The
observed state is existing OpenClaw config or workspace metadata.

### Channels

| Policy field                         | Observed state                          | Use when                                                     |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| `channels.denyRules[].when.provider` | `channels.*` provider and enabled state | Deny configured channels from a provider such as `telegram`. |
| `channels.denyRules[].reason`        | Finding message and repair hint context | Explain why the provider is denied.                          |

### MCP servers

| Policy field        | Observed state      | Use when                                                   |
| ------------------- | ------------------- | ---------------------------------------------------------- |
| `mcp.servers.allow` | `mcp.servers.*` ids | Require every configured MCP server to be in an allowlist. |
| `mcp.servers.deny`  | `mcp.servers.*` ids | Deny specific configured MCP server ids.                   |

### Model providers

| Policy field             | Observed state                                   | Use when                                                                        |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `models.providers.allow` | `models.providers.*` ids and selected model refs | Require configured providers and selected model refs to use approved providers. |
| `models.providers.deny`  | `models.providers.*` ids and selected model refs | Deny configured providers and selected model refs by provider id.               |

### Network

| Policy field                   | Observed state                      | Use when                                                           |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| `network.privateNetwork.allow` | Private-network SSRF escape hatches | Set to `false` to require private-network access to stay disabled. |

### Message routing

| Policy field                        | Observed state                                      | Use when                                                               |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `routing.requireBindings`           | Channel route bindings, excluding ACP bindings      | Require at least one message-routing binding.                          |
| `routing.requireConfiguredChannels` | Binding channel ids and configured `channels.*` ids | Detect stale or misspelled binding channel ids.                        |
| `routing.probes[].route`            | The public OpenClaw route resolver                  | Describe a representative inbound route without sending a message.     |
| `routing.probes[].expect.agentId`   | Resolved agent id                                   | Require the route to reach the reviewed agent.                         |
| `routing.probes[].expect.matchedBy` | Resolver match kind                                 | Require peer, account, channel, or other reviewed binding specificity. |

Probe ids must be unique. A route supports `channel`, optional `accountId`,
`peer`, `parentPeer`, `guildId`, `teamId`, and `memberRoleIds`. Peer kinds are
`direct`, `group`, and `channel`. `matchedBy` may contain one or more runtime
match kinds, including `binding.peer`, `binding.account`, `binding.channel`,
or `default`.

Routing checks are conformance checks only. They do not change startup,
message delivery, binding precedence, or fallback behavior. Findings require
operator review because automatically changing a binding could redirect
private messages.

### Ingress and channel access

| Policy field                              | Observed state                                                 | Use when                                                           |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ingress.session.requireDmScope`          | `session.dmScope`                                              | Require a reviewed direct-message isolation scope.                 |
| `ingress.channels.allowDmPolicies`        | `channels.*.dmPolicy` and legacy channel DM policy fields      | Allow only reviewed direct-message channel policies.               |
| `ingress.channels.denyOpenGroups`         | Channel, account, and group ingress policy                     | Deny open group ingress for configured channels and accounts.      |
| `ingress.channels.requireMentionInGroups` | Channel, account, group, guild, and nested mention gate config | Require mention gates when group ingress is open or mention-gated. |

### Gateway

| Policy field                            | Observed state                                | Use when                                                                             |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `gateway.exposure.allowNonLoopbackBind` | `gateway.bind`                                | Set to `false` to require loopback Gateway binding.                                  |
| `gateway.exposure.allowTailscaleFunnel` | Tailscale serve/funnel Gateway posture        | Set to `false` to deny Tailscale Funnel exposure.                                    |
| `gateway.auth.requireAuth`              | `gateway.auth.mode`                           | Set to `true` to reject disabled Gateway auth.                                       |
| `gateway.auth.requireExplicitRateLimit` | `gateway.auth.rateLimit`                      | Set to `true` to require explicit auth rate-limit config.                            |
| `gateway.controlUi.allowInsecure`       | Device-identity invariant and origin fallback | Set to `false` to require device identity and deny Host-header origin fallback.      |
| `gateway.remote.allow`                  | Remote Gateway mode/config                    | Set to `false` to deny remote Gateway mode.                                          |
| `gateway.http.denyEndpoints`            | Gateway HTTP API endpoints                    | Deny endpoint ids such as `chatCompletions` or `responses`.                          |
| `gateway.http.requireUrlAllowlists`     | Gateway HTTP URL-fetch inputs                 | Set to `true` to require URL allowlists on URL-fetch inputs.                         |
| `gateway.nodes.denyCommands`            | `gateway.nodes.commands.deny`                 | Require exact node command ids such as `system.run` to be denied in OpenClaw config. |

`gateway.nodes.denyCommands` is an exact, case-sensitive policy deny-superset rule.
Use it when policy must prove that privileged node commands are explicitly
denied by OpenClaw config. A deployment that intentionally allows a privileged
node command should update `policy.jsonc` after review instead of relying on
`gateway.nodes.commands.allow` alone.

### Agent workspace

| Policy field                     | Observed state                                                                           | Use when                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `agents.workspace.allowedAccess` | `agents.defaults.sandbox.workspaceAccess` and `agents.entries.*.sandbox.workspaceAccess` | Allow only sandbox workspace access values such as `none` or `ro`.                       |
| `agents.workspace.denyTools`     | Global and per-agent tool deny config                                                    | Require mutation tools (`exec`, `process`, `write`, `edit`, `apply_patch`) to be denied. |

### Sandbox posture

| Policy field                                          | Observed state                                          | Use when                                                           |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| `sandbox.requireMode`                                 | `agents.defaults.sandbox.mode` and per-agent mode       | Allow only reviewed sandbox modes such as `all` or `non-main`.     |
| `sandbox.allowBackends`                               | `agents.defaults.sandbox.backend` and per-agent backend | Allow only reviewed sandbox backends such as `docker` or `podman`. |
| `sandbox.containers.denyHostNetwork`                  | Container-backed sandbox/browser network mode           | Deny host network mode.                                            |
| `sandbox.containers.denyContainerNamespaceJoin`       | Container-backed sandbox/browser network mode           | Deny joining another container network namespace.                  |
| `sandbox.containers.requireReadOnlyMounts`            | Container-backed sandbox/browser mount mode             | Require mounts to be read-only.                                    |
| `sandbox.containers.denyContainerRuntimeSocketMounts` | Container-backed sandbox/browser mount targets          | Deny container runtime socket mounts.                              |
| `sandbox.containers.denyUnconfinedProfiles`           | Container security profile posture                      | Deny unconfined container security profiles.                       |
| `sandbox.browser.requireCdpSourceRange`               | Sandbox browser CDP source range                        | Require browser CDP exposure to declare a source range.            |

Policy treats missing `sandbox.mode` as its implicit default `off`, so
`sandbox.requireMode` reports a fresh or unconfigured sandbox as outside an
allowlist such as `["all"]`.

### Data Handling

| Policy field                                        | Observed state                                                                                                   | Use when                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `dataHandling.sensitiveLogging.requireRedaction`    | Runtime invariant `oc://openclaw.invariant/logging/redaction`                                                    | Set to `true` to record the requirement; OpenClaw always satisfies it. |
| `dataHandling.telemetry.denyContentCapture`         | `diagnostics.otel.captureContent`                                                                                | Set to `true` to reject telemetry content capture.                     |
| `dataHandling.retention.requireSessionMaintenance`  | `session.maintenance.mode`                                                                                       | Set to `true` to require effective session maintenance mode `enforce`. |
| `dataHandling.memory.denySessionTranscriptIndexing` | `memory.search.experimental.sessionMemory`, `memory.search.rememberAcrossConversations`, and per-agent overrides | Set to `true` to reject session transcript indexing into memory.       |

### Secrets

| Policy field                      | Observed state                                           | Use when                                                                |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `secrets.requireManagedProviders` | Config SecretRefs and `secrets.providers.*` declarations | Set to `true` to require SecretRefs to point at declared providers.     |
| `secrets.denySources`             | Secret provider sources and SecretRef sources            | Deny sources such as `exec`, `file`, or another configured source name. |
| `secrets.allowInsecureProviders`  | Insecure secret-provider posture flags                   | Set to `false` to reject providers that opt into insecure posture.      |

### Exec approvals

Exec-approvals checks read the runtime `exec_approvals_config` singleton row in
`~/.openclaw/state/openclaw.sqlite` by default, or the same database under
`$OPENCLAW_STATE_DIR/state` when `OPENCLAW_STATE_DIR` is set. Findings use the
stable `oc://exec-approvals.json/...` URI scheme, which addresses paths within
the authoritative JSON document stored in that row.
Posture rules under `execApprovals.defaults.*` or `execApprovals.agents.*`
require readable artifact evidence; a missing or invalid artifact reports as
unobservable evidence rather than a best-effort pass. Once readable, omitted
fields inherit runtime defaults: missing `defaults.security` is `full`, and
missing agent security inherits that default. Evidence includes `defaults`,
`agents.*`, `agents.*.allowlist[].pattern`, optional `argPattern`, effective
`autoAllowSkills` posture, and entry source — never socket path/token,
`commandText`, `lastUsedCommand`, resolved paths, or timestamps.

| Policy field                                | Observed state                                                                         | Use when                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `execApprovals.requireFile`                 | Active runtime `exec_approvals_config` row                                             | Set to `true` to require the approvals document to exist and parse.                     |
| `execApprovals.defaults.allowSecurity`      | `defaults.security`, defaulting to `full`                                              | Allow only approved default approval security modes.                                    |
| `execApprovals.agents.allowSecurity`        | `agents.*.security`, inheriting defaults                                               | Allow only approved per-agent effective approval security modes.                        |
| `execApprovals.agents.allowAutoAllowSkills` | `defaults.autoAllowSkills` and `agents.*.autoAllowSkills`, inheriting runtime defaults | Set to `false` to require strict manual allowlists without implicit skill CLI approval. |
| `execApprovals.agents.allowlist.expected`   | Aggregate `agents.*.allowlist[]` pattern and optional argPattern entries               | Require the approvals allowlist to match the reviewed pattern set.                      |

Example: require the approvals artifact, deny permissive defaults, and allow
only reviewed exec approval posture for selected agents.

```jsonc
{
  "execApprovals": {
    "requireFile": true,
    "defaults": {
      // Security modes: "deny", "allowlist", or "full".
      // This default permits only the locked-down deny posture.
      "allowSecurity": ["deny"],
    },
  },
  "scopes": {
    "restricted-shell": {
      "agentIds": ["family-agent", "groups-agent"],
      "execApprovals": {
        "agents": {
          // Selected agents may use reviewed allowlist posture, but not "full".
          "allowSecurity": ["allowlist"],
          // false means skill CLIs must appear in the reviewed allowlist instead of
          // being implicitly approved by autoAllowSkills.
          "allowAutoAllowSkills": false,
          "allowlist": {
            "expected": [
              // Simple entry: exact reviewed executable pattern with no argPattern.
              "travel-hub",
              // Constrained entry: pattern plus reviewed argument regex.
              { "pattern": "calendar-cli", "argPattern": "^sync\\b" },
              "/bin/date",
            ],
          },
        },
      },
    },
  },
}
```

### Auth profiles

| Policy field                    | Observed state                               | Use when                                                                                   |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth.profiles.requireMetadata` | `auth.profiles.*` provider and mode metadata | Require metadata keys such as `provider` and `mode` on config auth profiles.               |
| `auth.profiles.allowModes`      | `auth.profiles.*.mode`                       | Allow only supported auth profile modes such as `api_key`, `aws-sdk`, `oauth`, or `token`. |

### Tool metadata

| Policy field            | Observed state                         | Use when                                                                                   |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tools.requireMetadata` | Governed `AGENTS.md` tool declarations | Require governed tools to declare metadata keys such as `risk`, `sensitivity`, or `owner`. |

### Tool posture

| Policy field                    | Observed state                                              | Use when                                                                                                 |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tools.profiles.allow`          | `tools.profile` and `agents.entries.*.tools.profile`        | Allow only tool profile ids such as `minimal`, `messaging`, or `coding`.                                 |
| `tools.fs.requireWorkspaceOnly` | `tools.fs.workspaceOnly` and per-agent `tools.fs` overrides | Set to `true` to require workspace-only filesystem tool posture.                                         |
| `tools.exec.allowSecurity`      | `tools.exec.security` and per-agent exec security           | Allow only exec security modes such as `deny` or `allowlist`.                                            |
| `tools.exec.requireAsk`         | `tools.exec.ask` and per-agent exec ask mode                | Require approval posture such as `always`.                                                               |
| `tools.exec.allowHosts`         | `tools.exec.host` and per-agent exec host routing           | Allow only exec host routing modes such as `sandbox`.                                                    |
| `tools.elevated.allow`          | `tools.elevated.enabled` and per-agent elevated posture     | Set to `false` to require elevated tool mode to stay disabled.                                           |
| `tools.alsoAllow.expected`      | `tools.alsoAllow` and per-agent `tools.alsoAllow`           | Require exact `alsoAllow` entries and report missing or unexpected additive tool grants.                 |
| `tools.denyTools`               | `tools.deny` and `agents.entries.*.tools.deny`              | Require configured tool deny lists to include tool ids or groups such as `group:runtime` and `group:fs`. |

Tool requirements use the same group membership, aliases, and `*` matching as
core tool policy. For example, `group:fs` includes `ls`, `group:runtime` includes
`secrets`, `cron` resolves to `automations`, and the image-understanding tool is
`view_image`. A required deny list must cover every tool in a required group;
an empty list covers nothing, and denying `write` does not deny `apply_patch`.
