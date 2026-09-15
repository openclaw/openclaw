---
summary: "What each sandbox backend supports for shell, files, workspace, network, browser, and plugin tools"
title: "Supported capability matrix"
read_when: "You are comparing Docker, SSH, and OpenShell before choosing a backend."
---

A per-backend comparison of sandbox capabilities, and the Gateway-side execution that stays outside the sandbox boundary.

## Supported capability matrix

Sandbox backends isolate tool execution. They do not move the Gateway, native
plugins, or control-plane RPC into the sandbox.

| Capability                 | Docker                                                                  | SSH                                                  | OpenShell                                                                                |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shell and child processes  | Supported inside the container                                          | Supported on the remote host                         | Supported inside the managed sandbox                                                     |
| File tools                 | Supported through the container filesystem bridge                       | Supported through the SSH filesystem bridge          | Supported through the SSH bridge in `mirror` or `remote` mode                            |
| Workspace access           | `none`, `ro`, and `rw`                                                  | `none`, `ro`, and `rw`                               | `none`, `ro`, and `rw`                                                                   |
| Network restriction        | `docker.network`; defaults to `"none"`                                  | Controlled by the remote host                        | Controlled by the selected OpenShell policy                                              |
| Sandboxed browser          | Supported in a separate browser container                               | Not supported                                        | Not supported                                                                            |
| Additional host folders    | `docker.binds` with explicit `:ro` or `:rw`                             | Not supported as mounts; seed or copy files instead  | Not supported as mounts; use workspace sync or remote files                              |
| Packages and runtimes      | Bake a custom image, or use `setupCommand` with the required privileges | Provision them on the remote host                    | Include them in the source image or install when policy permits                          |
| Private certificate roots  | Bake or mount them into the image and configure the consuming runtime   | Configure the remote host trust store                | Include them in the source image or configure them inside sandbox                        |
| Plugin and MCP tool access | Gateway-side execution, additionally gated by sandbox tool policy       | Gateway-side execution, additionally gated by policy | Gateway-side by default; discovered sandbox stdio MCP servers run inside the environment |

Native plugins remain in-process with the Gateway and share its trust boundary.
Sandboxed sessions can use plugin-owned and MCP tools only when normal tool
policy and `tools.sandbox.tools` both allow them. See
[MCP and plugin tools inside sandbox tool policy](/gateway/config-tools#mcp-and-plugin-tools-inside-sandbox-tool-policy)
and [Plugin execution model](/plugins/architecture#execution-model).

### Environment capabilities

Sandbox backends may negotiate environment-owned capabilities with the built-in
agent runtime. The runtime uses a capability only when the backend both
advertises it and implements its matching method; absent capabilities preserve
the existing Gateway-owned behavior.

OpenShell in `remote` mode advertises protocol version 1 with process and
filesystem access plus workspace capability discovery. Each built-in agent
attempt shares one bounded discovery snapshot between environment-owned
`SKILL.md` files and workspace stdio MCP declarations. Skills use the existing
eligibility, session policy, and prompt limits; full instructions are read on
demand through the sandbox filesystem bridge.

Workspace `.mcp.json` is executable configuration and has no authority by
default. Before starting a declared server, OpenClaw requires an operator entry
under `agents.*.sandbox.environment.capabilityRoots` whose server name, command,
complete arguments, working directory, and environment exactly match the
declaration. The selection is also bound to the active backend, runtime, and
workspace root. Normal MCP and sandbox tool policies then decide which of the
server's tools the agent may invoke.

Authorized MCP working directories are resolved against the selected root and
validated by the backend before launch. The processes belong to the attempt,
including startup cancellation and remote descendant cleanup. `mirror` mode
does not advertise these capabilities: its local-canonical synchronization
transaction cannot own an attempt-long process without blocking later tools. See
[OpenShell environment-owned skills](/gateway/openshell#environment-owned-skills)
for discovery limits and exclusions.

Native plugins, `web_search`, `web_fetch`, configured Gateway MCP servers, and
HTTP/SSE MCP servers continue to run from the Gateway.
