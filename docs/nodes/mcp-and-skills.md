---
summary: "Publish MCP servers, skills, and local model inference from a paired node"
read_when:
  - Running MCP servers on a node instead of the Gateway
  - Publishing skills from a node machine
  - Exposing local Ollama models from a node
title: "Node-hosted MCP servers and skills"
sidebarTitle: "MCP and skills"
---

## Node-hosted MCP servers

Configure MCP servers in `openclaw.json` on the node machine, not on the
Gateway:

```json5
{
  nodeHost: {
    mcp: {
      servers: {
        localDocs: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"],
          toolFilter: {
            include: ["read_*", "search"],
          },
        },
        internalApi: {
          url: "https://mcp.internal.example/mcp",
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer ${INTERNAL_MCP_TOKEN}",
          },
        },
      },
    },
  },
}
```

The headless node host starts these servers, lists their tools, and publishes
the descriptors after connecting. Tool calls return to that node through
`mcp.tools.call.v1`; the Gateway does not need matching MCP config or a JS
plugin. OAuth MCP servers are not supported by this node-hosted v1 path.

Current node hosts declare the built-in `mcp.tools.call.v1` command family during
their initial pairing even when no MCP server is configured. A node paired on an
older OpenClaw version may request a one-time command-surface upgrade after the
node host is updated. Adding, removing, or filtering servers after that does not
require re-pairing because the approved command family is unchanged. Restart
`openclaw node run` or `openclaw node restart` to apply node MCP config changes;
the node host does not watch this config.

Server-advertised tool-list changes apply live and replace the published node
catalog. If an MCP transport closes or a stateful Streamable HTTP session
expires, the node withdraws that server's stale tools and reconnects with
bounded backoff. The failed call that detects an expired session is not replayed;
a later call can use the replacement connection after its tools are republished.

Gateway operators can ignore all agent-visible tools published by paired nodes,
including node-hosted MCP tools, with
`gateway.nodes.pluginTools.enabled: false`. Exact command denies such as
`gateway.nodes.commands.deny: ["mcp.tools.call.v1"]` also block execution.

## Node-hosted skills

Install skills under the node machine's active OpenClaw skills directory,
`~/.openclaw/skills` by default. `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and
`OPENCLAW_CONFIG_PATH` move that active profile. `OPENCLAW_STATE_DIR` takes
precedence for skills; otherwise, `skills/` is beside the path printed by
`openclaw config file`. The headless node host publishes valid `SKILL.md` files
after it connects, and the Gateway adds them to agent skill snapshots only while
that node remains connected. Each skill directory name must match the `name`
frontmatter field so the abstract node locator maps to one entry without adding
another protocol field.

The initial node-role pairing approves skill publication. Adding, removing, or
changing skills does not require another pairing or Gateway configuration
change. Restart `openclaw node run` or `openclaw node restart` after changing
node skill files; the node host does not watch the skills directory.

Node-hosted skill entries identify their node and carry their execution
location. Skill files, referenced relative paths, and binaries remain on that
node. The agent reads the advertised `node://.../SKILL.md` location with the
normal `read` tool. `file_fetch` accepts operator-approved absolute node paths,
not node skill locators; runtimes without the normal read tool can instead run
`cat SKILL.md` through `exec host=node node=<node-id>` with the advertised
`node://.../skills/<name>` directory as `workdir`. Referenced files and binaries
use the same exec target and workdir. The node host resolves that locator against
its active OpenClaw state directory, so relative paths resolve on the node rather
than the Gateway machine. The publishing node must have approved `system.run`,
and the agent's exec policy must allow `host=node`; otherwise the skill stays
out of that agent's snapshot.

Set `nodeHost.skills.enabled: false` on the node to stop publication. Gateway
operators can ignore skills from every paired node with
`gateway.nodes.allowSkills: false`.

## Local model inference

A desktop or server node can expose chat-capable models from an Ollama server running on that node. Agents use the Ollama plugin's `node_inference` tool to discover installed models and run a bounded prompt remotely; the Gateway does not need direct network access to Ollama. See [Ollama node-local inference](/providers/ollama#node-local-inference) for setup, model filtering, and direct verification commands.
