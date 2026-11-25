---
summary: "RPC method families, discovery, session list bootstrap, and event families"
read_when:
  - Looking up a gateway RPC method and its scope
  - Bootstrapping a session list or subscribing to event families
  - Implementing node helper methods or exec lifecycle handling
title: "Gateway protocol RPC methods"
sidebarTitle: "RPC methods"
doc-schema-version: 1
---

The gateway method surface, grouped into families, plus the session list bootstrap, the common event families, and the node helper and exec lifecycle contracts.

## RPC method families

`hello-ok.features.methods` is a conservative discovery list built from
`src/gateway/server-methods-list.ts` plus loaded plugin/channel method
exports — it is not a generated dump of every method, and some methods (for
example `push.test`, `web.login.start`, `web.login.wait`, `sessions.usage`)
are intentionally excluded from discovery even though they are real, callable
methods. Treat this as feature discovery, not a full enumeration of
`src/gateway/server-methods/*.ts`.

## What each page covers

- [System and channel methods](/gateway/protocol/rpc-system-and-channels) — system and identity, models and usage, channels and login helpers, plugin management, messaging and logs, and the operator terminal.
- [Talk, config, and agent methods](/gateway/protocol/rpc-talk-config-and-agents) — Talk and TTS, secrets, config, update, and wizard, and agent and workspace helpers.
- [Session control](/gateway/protocol/rpc-session-control) — the session control family: listing, sending, streaming, run lifecycle, and session maintenance.
- [Devices, nodes, and approvals](/gateway/protocol/rpc-devices-nodes-and-approvals) — device pairing and device tokens, node pairing and invoke, approval families, Control UI commands, and automation, skills, and tools.
- [Session list bootstrap and events](/gateway/protocol/rpc-bootstrap-and-events) — the session list bootstrap, the common event families, and the node helper and exec lifecycle contracts.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link to this page with a fragment still resolves. Each entry points at the page that now holds the content.

- <a id="system-and-identity" />[System and identity](/gateway/protocol/rpc-system-and-channels#system-and-identity)
- <a id="models-and-usage" />[Models and usage](/gateway/protocol/rpc-system-and-channels#models-and-usage)
- <a id="channels-and-login-helpers" />[Channels and login helpers](/gateway/protocol/rpc-system-and-channels#channels-and-login-helpers)
- <a id="plugin-management" />[Plugin management](/gateway/protocol/rpc-system-and-channels#plugin-management)
- <a id="messaging-and-logs" />[Messaging and logs](/gateway/protocol/rpc-system-and-channels#messaging-and-logs)
- <a id="operator-terminal" />[Operator terminal](/gateway/protocol/rpc-system-and-channels#operator-terminal)
- <a id="talk-and-tts" />[Talk and TTS](/gateway/protocol/rpc-talk-config-and-agents#talk-and-tts)
- <a id="secrets%2C-config%2C-update%2C-and-wizard" />[Secrets, config, update, and wizard](/gateway/protocol/rpc-talk-config-and-agents#secrets%2C-config%2C-update%2C-and-wizard)
- <a id="secrets-config-update-and-wizard" />[Secrets, config, update, and wizard](/gateway/protocol/rpc-talk-config-and-agents#secrets-config-update-and-wizard)
- <a id="agent-and-workspace-helpers" />[Agent and workspace helpers](/gateway/protocol/rpc-talk-config-and-agents#agent-and-workspace-helpers)
- <a id="session-control" />[Session control](/gateway/protocol/rpc-session-control#session-control)
- <a id="device-pairing-and-device-tokens" />[Device pairing and device tokens](/gateway/protocol/rpc-devices-nodes-and-approvals#device-pairing-and-device-tokens)
- <a id="node-pairing%2C-invoke%2C-and-pending-work" />[Node pairing, invoke, and pending work](/gateway/protocol/rpc-devices-nodes-and-approvals#node-pairing%2C-invoke%2C-and-pending-work)
- <a id="node-pairing-invoke-and-pending-work" />[Node pairing, invoke, and pending work](/gateway/protocol/rpc-devices-nodes-and-approvals#node-pairing-invoke-and-pending-work)
- <a id="approval-families" />[Approval families](/gateway/protocol/rpc-devices-nodes-and-approvals#approval-families)
- <a id="control-ui-commands" />[Control UI commands](/gateway/protocol/rpc-devices-nodes-and-approvals#control-ui-commands)
- <a id="automation%2C-skills%2C-and-tools" />[Automation, skills, and tools](/gateway/protocol/rpc-devices-nodes-and-approvals#automation%2C-skills%2C-and-tools)
- <a id="automation-skills-and-tools" />[Automation, skills, and tools](/gateway/protocol/rpc-devices-nodes-and-approvals#automation-skills-and-tools)
- <a id="session-list-bootstrap" />[Session list bootstrap](/gateway/protocol/rpc-bootstrap-and-events#session-list-bootstrap)
- <a id="common-event-families" />[Common event families](/gateway/protocol/rpc-bootstrap-and-events#common-event-families)
- <a id="node-helper-methods" />[Node helper methods](/gateway/protocol/rpc-bootstrap-and-events#node-helper-methods)
- <a id="node-exec-lifecycle-events" />[Node exec lifecycle events](/gateway/protocol/rpc-bootstrap-and-events#node-exec-lifecycle-events)
