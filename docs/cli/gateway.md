---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (local + wide-area DNS-SD)
  - Integrating an external Gateway process supervisor
title: "Gateway"
sidebarTitle: "Gateway"
---

The Gateway is OpenClaw's WebSocket server (channels, nodes, sessions, hooks). All subcommands on the pages listed here live under `openclaw gateway ...`.

<CardGroup cols={3}>
  <Card title="Bonjour discovery" href="/gateway/bonjour">
    Local mDNS + wide-area DNS-SD setup.
  </Card>
  <Card title="Discovery overview" href="/gateway/discovery">
    How OpenClaw advertises and finds gateways.
  </Card>
  <Card title="Configuration" href="/gateway/configuration">
    Top-level gateway config keys.
  </Card>
</CardGroup>

## Gateway CLI pages

This page is an index. Five pages document `openclaw gateway`, one per reader
job. Open the page that matches your task.

| Page                                                            | Read it when                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Run the Gateway](/cli/gateway/running)                         | You are starting the Gateway, tuning its run options, or reading its shared token. |
| [Restart and supervision](/cli/gateway/restart-and-supervision) | You are restarting the Gateway, or an external supervisor owns its lifecycle.      |
| [Query a running Gateway](/cli/gateway/query)                   | You want health, status, stability, diagnostics, or a direct RPC call.             |
| [Manage the Gateway service](/cli/gateway/service)              | You are installing, starting, stopping, or repairing the native service.           |
| [Discover gateways (Bonjour)](/cli/gateway/discovery)           | You are looking for gateways over mDNS or wide-area DNS-SD.                        |

## Where each section moved

Every anchor from the previous single-page version still resolves here, so an
existing link such as `/cli/gateway#manage-the-gateway-service` keeps working.
Each entry points at the page that now holds the content.

- <a id="run-the-gateway" />[Run the Gateway](/cli/gateway/running#run-the-gateway)
- <a id="options" />[Options](/cli/gateway/running#options)
- <a id="reveal-the-configured-token" />[Reveal the configured token](/cli/gateway/running#reveal-the-configured-token)
- <a id="restart-the-gateway" />[Restart the Gateway](/cli/gateway/restart-and-supervision#restart-the-gateway)
- <a id="install-identity" />[Install identity](/cli/gateway/restart-and-supervision#install-identity)
- <a id="external-supervisors" />[External supervisors](/cli/gateway/restart-and-supervision#external-supervisors)
- <a id="gateway-profiling" />[Gateway profiling](/cli/gateway/restart-and-supervision#gateway-profiling)
- <a id="query-a-running-gateway" />[Query a running Gateway](/cli/gateway/query#query-a-running-gateway)
- <a id="gateway-health" />[`gateway health`](/cli/gateway/query#gateway-health)
- <a id="gateway-usage-cost" />[`gateway usage-cost`](/cli/gateway/query#gateway-usage-cost)
- <a id="gateway-stability" />[`gateway stability`](/cli/gateway/query#gateway-stability)
- <a id="gateway-diagnostics-export" />[`gateway diagnostics export`](/cli/gateway/query#gateway-diagnostics-export)
- <a id="gateway-status" />[`gateway status`](/cli/gateway/query#gateway-status)
- <a id="gateway-probe" />[`gateway probe`](/cli/gateway/query#gateway-probe)
- <a id="remote-over-ssh-(mac-app-parity)" />[Remote over SSH (Mac app parity)](/cli/gateway/query#remote-over-ssh-%28mac-app-parity%29)
- <a id="gateway-call-%3Cmethod%3E" />[`gateway call <method>`](/cli/gateway/query#gateway-call-%3Cmethod%3E)
- <a id="gateway-suspend" />[`gateway suspend`](/cli/gateway/query#gateway-suspend)
- <a id="gateway-resume-%3Csuspensionid%3E" />[`gateway resume <suspensionId>`](/cli/gateway/query#gateway-resume-%3Csuspensionid%3E)
- <a id="manage-the-gateway-service" />[Manage the Gateway service](/cli/gateway/service#manage-the-gateway-service)
- <a id="recover-an-unreadable-native-service-definition" />[Recover an unreadable native service definition](/cli/gateway/service#recover-an-unreadable-native-service-definition)
- <a id="lifecycle-requests-from-gateway-chat" />[Lifecycle requests from Gateway chat](/cli/gateway/service#lifecycle-requests-from-gateway-chat)
- <a id="install-with-a-wrapper" />[Install with a wrapper](/cli/gateway/service#install-with-a-wrapper)
- <a id="discover-gateways-(bonjour)" />[Discover gateways (Bonjour)](/cli/gateway/discovery#discover-gateways-%28bonjour%29)
- <a id="gateway-discover" />[`gateway discover`](/cli/gateway/discovery#gateway-discover)
- <a id="remote-over-ssh-mac-app-parity" />[Remote over SSH (Mac app parity)](/cli/gateway/query#remote-over-ssh-mac-app-parity)
- <a id="gateway-call-&lt;method&gt;" />[`gateway call <method>`](/cli/gateway/query#gateway-call-%3Cmethod%3E)
- <a id="gateway-resume-&lt;suspensionid&gt;" />[`gateway resume <suspensionId>`](/cli/gateway/query#gateway-resume-%3Csuspensionid%3E)
- <a id="discover-gateways-bonjour" />[Discover gateways (Bonjour)](/cli/gateway/discovery#discover-gateways-bonjour)

Option, tab, and panel anchors:

- <a id="startup-behavior" />[Startup behavior](/cli/gateway/running#startup-behavior)
- <a id="param-port" />[`--port`](/cli/gateway/running#param-port)
- <a id="param-bind" />[`--bind`](/cli/gateway/running#param-bind)
- <a id="param-token" />[`--token`](/cli/gateway/running#param-token)
- <a id="param-auth" />[`--auth`](/cli/gateway/running#param-auth)
- <a id="param-password" />[`--password`](/cli/gateway/running#param-password)
- <a id="param-tailscale" />[`--tailscale`](/cli/gateway/running#param-tailscale)
- <a id="param-allow-unconfigured" />[`--allow-unconfigured`](/cli/gateway/running#param-allow-unconfigured)
- <a id="param-dev" />[`--dev`](/cli/gateway/running#param-dev)
- <a id="param-ambient-channels" />[`--ambient-channels`](/cli/gateway/running#param-ambient-channels)
- <a id="param-dev-ambient-channels" />[`--dev-ambient-channels`](/cli/gateway/running#param-dev-ambient-channels)
- <a id="param-reset" />[`--reset`](/cli/gateway/running#param-reset)
- <a id="param-force" />[`--force`](/cli/gateway/running#param-force)
- <a id="param-verbose" />[`--verbose`](/cli/gateway/running#param-verbose)
- <a id="param-cli-backend-logs" />[`--cli-backend-logs`](/cli/gateway/running#param-cli-backend-logs)
- <a id="param-ws-log" />[`--ws-log`](/cli/gateway/running#param-ws-log)
- <a id="param-compact" />[`--compact`](/cli/gateway/running#param-compact)
- <a id="param-raw-stream" />[`--raw-stream`](/cli/gateway/running#param-raw-stream)
- <a id="output-modes" />[Output modes](/cli/gateway/query#output-modes)
- <a id="shared-options" />[Shared options](/cli/gateway/query#shared-options)
- <a id="param-port-1" />[`--port`](/cli/gateway/query#param-port)
- <a id="param-days" />[`--days`](/cli/gateway/query#param-days)
- <a id="param-agent" />[`--agent`](/cli/gateway/query#param-agent)
- <a id="param-all-agents" />[`--all-agents`](/cli/gateway/query#param-all-agents)
- <a id="param-limit" />[`--limit`](/cli/gateway/query#param-limit)
- <a id="param-type" />[`--type`](/cli/gateway/query#param-type)
- <a id="param-since-seq" />[`--since-seq`](/cli/gateway/query#param-since-seq)
- <a id="param-bundle-path" />[`--bundle`](/cli/gateway/query#param-bundle-path)
- <a id="param-export" />[`--export`](/cli/gateway/query#param-export)
- <a id="privacy-and-bundle-behavior" />[Privacy and bundle behavior](/cli/gateway/query#privacy-and-bundle-behavior)
- <a id="param-log-lines" />[`--log-lines`](/cli/gateway/query#param-log-lines)
- <a id="param-log-bytes" />[`--log-bytes`](/cli/gateway/query#param-log-bytes)
- <a id="param-url" />[`--url`](/cli/gateway/query#param-url)
- <a id="param-token-1" />[`--token`](/cli/gateway/query#param-token)
- <a id="param-password-1" />[`--password`](/cli/gateway/query#param-password)
- <a id="param-timeout" />[`--timeout`](/cli/gateway/query#param-timeout)
- <a id="param-no-stability-bundle" />[`--no-stability-bundle`](/cli/gateway/query#param-no-stability-bundle)
- <a id="param-json" />[`--json`](/cli/gateway/query#param-json)
- <a id="param-url-1" />[`--url`](/cli/gateway/query#param-url-1)
- <a id="param-port-2" />[`--port`](/cli/gateway/query#param-port-1)
- <a id="param-token-2" />[`--token`](/cli/gateway/query#param-token-1)
- <a id="param-password-2" />[`--password`](/cli/gateway/query#param-password-1)
- <a id="param-timeout-1" />[`--timeout`](/cli/gateway/query#param-timeout-1)
- <a id="param-no-probe" />[`--no-probe`](/cli/gateway/query#param-no-probe)
- <a id="param-deep" />[`--deep`](/cli/gateway/query#param-deep)
- <a id="param-require-rpc" />[`--require-rpc`](/cli/gateway/query#param-require-rpc)
- <a id="status-semantics" />[Status semantics](/cli/gateway/query#status-semantics)
- <a id="linux-systemd-auth-drift-checks" />[Linux systemd auth-drift checks](/cli/gateway/query#linux-systemd-auth-drift-checks)
- <a id="param-port-3" />[`--port`](/cli/gateway/query#param-port-2)
- <a id="interpretation" />[Interpretation](/cli/gateway/query#interpretation)
- <a id="json-output" />[JSON output](/cli/gateway/query#json-output)
- <a id="common-warning-codes" />[Common warning codes](/cli/gateway/query#common-warning-codes)
- <a id="param-ssh" />[`--ssh`](/cli/gateway/query#param-ssh)
- <a id="param-ssh-auto" />[`--ssh-auto`](/cli/gateway/query#param-ssh-auto)
- <a id="param-params" />[`--params`](/cli/gateway/query#param-params)
- <a id="param-url-2" />[`--url`](/cli/gateway/query#param-url-2)
- <a id="param-port-4" />[`--port`](/cli/gateway/query#param-port-3)
- <a id="param-token-3" />[`--token`](/cli/gateway/query#param-token-2)
- <a id="param-password-3" />[`--password`](/cli/gateway/query#param-password-2)
- <a id="param-timeout-2" />[`--timeout`](/cli/gateway/query#param-timeout-2)
- <a id="param-expect-final" />[`--expect-final`](/cli/gateway/query#param-expect-final)
- <a id="param-json-1" />[`--json`](/cli/gateway/query#param-json-1)
- <a id="command-options" />[Command options](/cli/gateway/service#command-options)
- <a id="service-runtime" />[Service runtime](/cli/gateway/service#service-runtime)
- <a id="lifecycle-behavior" />[Lifecycle behavior](/cli/gateway/service#lifecycle-behavior)
- <a id="managed-gateway-heap-sizing" />[Managed Gateway heap sizing](/cli/gateway/service#managed-gateway-heap-sizing)
- <a id="auth-and-secretrefs-at-install-time" />[Auth and SecretRefs at install time](/cli/gateway/service#auth-and-secretrefs-at-install-time)
- <a id="param-timeout-3" />[`--timeout`](/cli/gateway/discovery#param-timeout)
- <a id="param-json-2" />[`--json`](/cli/gateway/discovery#param-json)

## Related

- [CLI reference](/cli)
- [Gateway runbook](/gateway)
