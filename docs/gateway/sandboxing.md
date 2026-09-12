---
summary: "How OpenClaw sandboxing works: modes, scopes, workspace access, and images"
title: "Sandboxing"
sidebarTitle: "Sandboxing"
read_when: "You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox."
status: active
---

OpenClaw can run tool execution inside a sandbox backend to reduce blast radius. Sandboxing is off by default and controlled by `agents.defaults.sandbox` (global), `agents.entries.*.sandbox` (per-agent), or a required creator-role sandbox policy. The Gateway process always stays on the host; only tool execution moves into the sandbox when enabled.

<Note>
This is not a perfect security boundary, but it materially limits filesystem and process access when the model does something dumb.
</Note>

## Sandboxing pages

This page is an index. The sandbox reference is documented on eleven
pages. Open the page that matches what you are configuring.

| Page                                                                                 | Read it when                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [What gets sandboxed](/gateway/sandboxing/what-gets-sandboxed)                       | You want to know exactly which execution moves into the sandbox.               |
| [Modes, scope, and backend](/gateway/sandboxing/modes-scope-and-backend)             | You are deciding which sessions run sandboxed and how they share environments. |
| [Supported capability matrix](/gateway/sandboxing/supported-capability-matrix)       | You are comparing Docker, SSH, and OpenShell before choosing a backend.        |
| [Docker backend](/gateway/sandboxing/docker-backend)                                 | You are running the default local backend or enabling the sandboxed browser.   |
| [Podman backend](/gateway/sandboxing/podman-backend)                                 | You are using Podman instead of Docker for sandboxed tool execution.           |
| [SSH backend](/gateway/sandboxing/ssh-backend)                                       | You are offloading sandboxed tool execution to a remote machine over SSH.      |
| [OpenShell backend](/gateway/sandboxing/openshell-backend)                           | You are sandboxing tools in an OpenShell-managed remote environment.           |
| [Workspace access](/gateway/sandboxing/workspace-access)                             | You are deciding what the sandbox can see of the agent workspace.              |
| [Multiple folders for one agent](/gateway/sandboxing/multiple-folders-for-one-agent) | One sandboxed agent needs more than its primary workspace.                     |
| [Images and setup](/gateway/sandboxing/images-and-setup)                             | You need to build or customize a sandbox image.                                |
| [setupCommand (one-time container setup)](/gateway/sandboxing/setup-command)         | You need to run one-time setup inside a newly created sandbox container.       |

## Where each section moved

Every anchor this page used to publish is kept here, so an existing link
such as `/gateway/sandboxing#images-and-setup` still resolves. Each entry
points at the page that now holds the content.

- <a id="what-gets-sandboxed" />[What gets sandboxed](/gateway/sandboxing/what-gets-sandboxed#what-gets-sandboxed)
- <a id="modes%2C-scope%2C-and-backend" /><a id="modes-scope-and-backend" />[Modes, scope, and backend](/gateway/sandboxing/modes-scope-and-backend#modes-scope-and-backend)
- <a id="supported-capability-matrix" />[Supported capability matrix](/gateway/sandboxing/supported-capability-matrix#supported-capability-matrix)
- <a id="docker-backend" />[Docker backend](/gateway/sandboxing/docker-backend#docker-backend)
- <a id="sandboxed-browser" />[Sandboxed browser](/gateway/sandboxing/docker-backend#sandboxed-browser)
- <a id="podman-backend" />[Podman backend](/gateway/sandboxing/podman-backend#podman-backend)
- <a id="ssh-backend" />[SSH backend](/gateway/sandboxing/ssh-backend#ssh-backend)
- <a id="openshell-backend" />[OpenShell backend](/gateway/sandboxing/openshell-backend#openshell-backend)
- <a id="workspace-access" />[Workspace access](/gateway/sandboxing/workspace-access#workspace-access)
- <a id="multiple-folders-for-one-agent" />[Multiple folders for one agent](/gateway/sandboxing/multiple-folders-for-one-agent#multiple-folders-for-one-agent)
- <a id="other-bind-behavior" />[Other bind behavior](/gateway/sandboxing/multiple-folders-for-one-agent#other-bind-behavior)
- <a id="images-and-setup" />[Images and setup](/gateway/sandboxing/images-and-setup#images-and-setup)
- <a id="build-the-default-image" />[Build the default image](/gateway/sandboxing/images-and-setup#build-the-default-image)
- <a id="optional%3A-build-the-common-image" />[Optional: build the common image](/gateway/sandboxing/images-and-setup#optional%3A-build-the-common-image)
- <a id="optional%3A-build-the-sandbox-browser-image" />[Optional: build the sandbox browser image](/gateway/sandboxing/images-and-setup#optional%3A-build-the-sandbox-browser-image)
- <a id="sandbox-browser-chromium-defaults" />[Sandbox browser Chromium defaults](/gateway/sandboxing/images-and-setup#sandbox-browser-chromium-defaults)
- <a id="network-security-defaults" />[Network security defaults](/gateway/sandboxing/images-and-setup#network-security-defaults)
- <a id="setupcommand-(one-time-container-setup)" /><a id="setupcommand-one-time-container-setup" />[setupCommand (one-time container setup)](/gateway/sandboxing/setup-command#setupcommand-one-time-container-setup)
- <a id="common-pitfalls" />[Common pitfalls](/gateway/sandboxing/setup-command#common-pitfalls)

## Tool policy and escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied globally or per-agent, sandboxing doesn't bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` outside the sandbox (`gateway` by default, or `node` when the exec target is `node`). `/exec` directives only apply for authorized senders and persist per session; to hard-disable `exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- `openclaw sandbox list` shows sandbox containers, status, image match, age, idle time, and associated session/agent.
- `openclaw sandbox explain [--session <key>] [--agent <id>]` inspects effective sandbox mode, host workspace, runtime workdir, Docker mounts, tool policy, and fix-it config keys. Its `workspaceRoot` field remains the configured sandbox root; `effectiveHostWorkspaceRoot` shows where the active workspace actually lives.
- `openclaw sandbox recreate [--all | --session <key> | --agent <id>] [--browser] [--force]` removes containers/environments so they get recreated with current config on next use.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the "why is this blocked?" mental model.

## Multi-agent overrides

Each agent can override sandbox + tools: `agents.entries.*.sandbox` and `agents.entries.*.tools` (plus `agents.entries.*.tools.sandbox.tools` for sandbox tool policy). See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Related

- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides and precedence
- [OpenShell](/gateway/openshell) -- managed sandbox backend setup, workspace modes, and config reference
- [Sandbox configuration](/gateway/config-agents/sandbox#agentsdefaultssandbox)
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- debugging "why is this blocked?"
- [Security](/gateway/security)
- [`openclaw sandbox`](/cli/sandbox) — manage sandbox runtimes and inspect the effective sandbox policy
- [Cloud Workers](/gateway/cloud-workers) — dispatching session work to throwaway cloud machines; its managed workspace is not an OS sandbox
