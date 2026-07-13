---
summary: "Current integration path for external apps, scripts, dashboards, CI jobs, and IDE extensions"
title: "Gateway integrations for external apps"
sidebarTitle: "External apps"
read_when:
  - You are building an external app, script, dashboard, CI job, or IDE extension that talks to OpenClaw
  - You are choosing between Gateway RPC and the Plugin SDK
  - You are integrating with Gateway agent runs, sessions, events, approvals, models, or tools
---

External apps talk to OpenClaw through the Gateway protocol: WebSocket
transport plus RPC methods. Use it when a script, dashboard, CI job, IDE
extension, or another process wants to start agent runs, stream events, wait
for results, cancel work, or inspect Gateway resources.

<Warning>
  There is no public npm client package yet. Do not add OpenClaw client package
  names as application dependencies until release notes announce a published
  package and this page includes install instructions.
</Warning>

<Note>
  This page is for code outside the OpenClaw process. Plugin code that runs
  inside OpenClaw should use documented `openclaw/plugin-sdk/*` subpaths instead.
</Note>

## What is available today

| Surface                                 | Status | Use it for                                                                                    |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| [Gateway protocol](/gateway/protocol)   | Ready  | WebSocket transport, connect handshake, auth scopes, protocol versioning, and events.         |
| [Gateway RPC reference](/reference/rpc) | Ready  | Current Gateway methods for agents, sessions, tasks, models, tools, artifacts, and approvals. |
| [`openclaw agent`](/cli/agent)          | Ready  | One-shot script integration when shelling out to the CLI is enough.                           |
| [`openclaw message`](/cli/message)      | Ready  | Sending messages or channel actions from scripts.                                             |

A future client library package is in progress internally, but it is not a
public install surface yet. Treat it as preview implementation detail until a
release announces a published, versioned package.

## Recommended path

1. Run or discover a Gateway.
2. Connect over the [Gateway protocol](/gateway/protocol).
3. Call documented RPC methods from [Gateway RPC reference](/reference/rpc).
4. Pin the OpenClaw version you test against.
5. Recheck the RPC reference when upgrading OpenClaw.

For agent runs, start with the `agent` RPC and pair it with `agent.wait` for a
terminal result. For durable conversation state, use the `sessions.*` methods.
For UI integrations, subscribe to Gateway events and render only the event
families your app understands.

## App code vs plugin code

Use Gateway RPC when code lives outside OpenClaw:

- Node scripts that start or observe agent runs
- CI jobs that call a Gateway
- dashboards and admin panels
- IDE extensions
- external bridges that do not need to become channel plugins
- integration tests with fake or real Gateway transports

Use the Plugin SDK when code runs inside OpenClaw:

- provider plugins
- channel plugins
- tool or lifecycle hooks
- agent harness plugins
- trusted runtime helpers

External apps should not import `openclaw/plugin-sdk/*`; those subpaths are for
plugins loaded by OpenClaw.

## Related

- [Gateway protocol](/gateway/protocol)
- [Gateway RPC reference](/reference/rpc)
- [CLI agent command](/cli/agent)
- [CLI message command](/cli/message)
- [Agent loop](/concepts/agent-loop)
- [Agent runtimes](/concepts/agent-runtimes)
- [Sessions](/concepts/session)
- [Background tasks](/automation/tasks)
- [ACP agents](/tools/acp-agents)
- [Plugin SDK overview](/plugins/sdk-overview)
