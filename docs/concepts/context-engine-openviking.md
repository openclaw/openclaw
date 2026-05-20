---
summary: "Remote memory, archives, resources, and recall through the OpenViking context-engine plugin"
title: "OpenViking context engine"
sidebarTitle: "OpenViking"
read_when:
  - You want OpenViking as an optional OpenClaw context engine
  - You want remote long-term memory, session archives, and resource search
  - You are deciding whether OpenViking should replace the legacy context engine
---

[OpenViking](https://github.com/volcengine/OpenViking) is an OpenClaw
**context engine** plugin with the id `openviking`. It replaces OpenClaw's
default context assembly path with a remote OpenViking-backed engine that stores
conversation history, extracts long-term user and agent memories, searches
imported resources, and feeds relevant context back into OpenClaw before model
calls.

That placement is important:

- `plugins.slots.contextEngine = "openviking"` selects OpenViking for context
  assembly, archive-backed compaction, and post-turn capture.
- `plugins.slots.memory` is still the active memory plugin slot. You can leave
  `memory-core` enabled for local Markdown memory, or select another memory
  plugin separately.
- The OpenViking server runs outside OpenClaw. The plugin is a remote HTTP
  client; it does not start or supervise the server.

Use OpenViking when you want remote context assembly, archive-backed
compaction, and long-term recall across agents or OpenClaw instances.

## What it provides

- **Remote long-term memory**: OpenViking extracts durable user and agent memory
  from OpenClaw sessions and stores it under OpenViking namespaces such as
  `viking://user/...` and `viking://agent/...`.
- **Automatic recall**: before a model run, the plugin searches OpenViking for
  relevant memories and injects a bounded `<relevant-memories>` block into the
  latest user message.
- **Session archives**: older conversation history is committed into OpenViking
  archives. OpenClaw receives archive summaries and recent active messages
  instead of an ever-growing raw transcript.
- **Archive expansion**: when a summary is not enough, the agent can search or
  expand archived original messages through OpenViking tools.
- **Resource and skill search**: the plugin can import files, directories, URLs,
  Git repositories, and skills into OpenViking, then search them during later
  turns.
- **Multi-agent routing**: the plugin derives an OpenViking agent id from the
  OpenClaw session and optional `agent_prefix`, so different agents can avoid
  mixing memory.

## Install

### 1. Start OpenViking

Run an OpenViking server that OpenClaw can reach. For a local server:

```bash
pip install openviking --upgrade --force-reinstall
openviking-server init
openviking-server doctor
openviking-server
```

The default local HTTP endpoint is `http://127.0.0.1:1933`.

For a server on another machine, bind it to a reachable address:

```bash
openviking-server --host 0.0.0.0 --port 1933
```

Then verify the server:

```bash
curl http://127.0.0.1:1933/health
```

### 2. Install the OpenClaw plugin

Install the OpenViking plugin from ClawHub:

```bash
openclaw plugins install clawhub:@openviking/openclaw-plugin
```

Current OpenClaw versions require the `clawhub:` prefix when you want to force
ClawHub as the source. The bare command below installs the same package name
through the normal npm package path instead:

```bash
openclaw plugins install @openviking/openclaw-plugin
```

Use the explicit `clawhub:` form when you want OpenClaw-native ClawHub package
metadata and install provenance.

### 3. Configure the plugin

Run the plugin setup command. For interactive setup:

```bash
openclaw openviking setup
```

For non-interactive setup:

```bash
openclaw openviking setup \
  --base-url http://127.0.0.1:1933 \
  --api-key sk-xxx \
  --json
```

Setup writes `plugins.entries.openviking.config` and selects the OpenViking
context engine by setting `plugins.slots.contextEngine` to `openviking`.

If the server is temporarily unreachable but you still want to save config:

```bash
openclaw openviking setup \
  --base-url http://127.0.0.1:1933 \
  --api-key sk-xxx \
  --allow-offline \
  --json
```

If another context engine already owns the slot, setup will not replace it
unless you pass `--force-slot`.

### 4. Restart and verify

Restart the Gateway so the plugin code and selected context engine are active:

```bash
openclaw gateway restart
```

Then verify the integration:

```bash
openclaw openviking status --json
```

Look for:

| Field        | Expected value                                 |
| ------------ | ---------------------------------------------- |
| `configured` | `true`                                         |
| `slotActive` | `true`                                         |
| `health.ok`  | `true` when the OpenViking server is reachable |

You can also inspect the raw OpenClaw config:

```bash
openclaw config get plugins.entries.openviking.config
openclaw config get plugins.slots.contextEngine
```

`plugins.slots.contextEngine` should print `openviking`.

## Configuration

The main config lives under `plugins.entries.openviking.config`:

```json5
{
  plugins: {
    slots: {
      contextEngine: "openviking",
    },
    entries: {
      openviking: {
        enabled: true,
        config: {
          baseUrl: "http://127.0.0.1:1933",
          apiKey: "${OPENVIKING_API_KEY}",
          agent_prefix: "",
          autoRecall: true,
          autoCapture: true,
          recallLimit: 6,
          recallMaxInjectedChars: 4000,
          commitTokenThreshold: 20000,
        },
      },
    },
  },
}
```

Common fields:

| Field                     | Default                 | Purpose                                                                                                                           |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                 | `http://127.0.0.1:1933` | OpenViking HTTP endpoint. Can also come from `OPENVIKING_BASE_URL` or `OPENVIKING_URL`.                                           |
| `apiKey`                  | empty                   | Optional OpenViking API key. Can also come from `OPENVIKING_API_KEY`.                                                             |
| `agent_prefix`            | empty                   | Optional prefix for OpenViking agent ids, useful when several OpenClaw installs share one server.                                 |
| `accountId` / `userId`    | empty                   | Advanced tenant headers, usually needed only with root keys or trusted server flows.                                              |
| `autoRecall`              | `true`                  | Search OpenViking before a turn and inject relevant memories.                                                                     |
| `recallResources`         | `false`                 | Include `viking://resources` in automatic recall and default recall searches.                                                     |
| `recallLimit`             | `6`                     | Maximum selected memories before budget trimming.                                                                                 |
| `recallMaxInjectedChars`  | `4000`                  | Total character budget for the injected recall block. Individual memories are skipped rather than truncated when they do not fit. |
| `autoCapture`             | `true`                  | Append completed turns to OpenViking and trigger extraction when the session crosses the commit threshold.                        |
| `commitTokenThreshold`    | `20000`                 | Pending-token threshold before `afterTurn` starts an async OpenViking commit.                                                     |
| `commitKeepRecentCount`   | `10`                    | Number of recent messages the OpenViking server should keep live after an async commit.                                           |
| `bypassSessionPatterns`   | `[]`                    | Session-key glob patterns that completely bypass OpenViking.                                                                      |
| `emitStandardDiagnostics` | `false`                 | Emit structured `openviking: diag {...}` logs for assemble and after-turn phases.                                                 |
| `logFindRequests`         | `false`                 | Log routing details for search and session writes without logging the API key.                                                    |

Namespace fields such as `isolateUserScopeByAgent` and
`isolateAgentScopeByUser` must match the OpenViking server-side account policy.
Leave them unset unless your OpenViking deployment explicitly uses isolated
user/agent namespace variants.

## How it works

OpenViking participates in the OpenClaw context-engine lifecycle.

### Assemble

During prompt assembly, OpenViking handles two jobs:

1. It reads archive and active-session context back from OpenViking and rebuilds
   the message list that OpenClaw sends to the model.
2. It searches `viking://user/memories` and `viking://agent/memories`, plus
   `viking://resources` when `recallResources` is enabled, then injects the
   selected memories into the latest user message.

The recall path uses a quick availability precheck so a down OpenViking server
does not stall every model request. Results are deduplicated, thresholded,
reranked, and trimmed to the configured injection budget.

### After turn

After an agent turn, the plugin appends only the new turn to the OpenViking
session. It strips OpenViking's own injected recall block before capture and
preserves useful tool-call and tool-result text for later archive search.

When pending session tokens reach `commitTokenThreshold`, the plugin starts an
async OpenViking commit with `wait=false`. Archive generation and memory
extraction continue on the OpenViking server, so the current OpenClaw reply is
not blocked waiting for extraction.

### Compact and reset

When OpenClaw compacts, the OpenViking engine commits with `wait=true`. It waits
for the archive and memory extraction result, then returns the latest archive
overview as the compacted session summary.

Before a session reset, the plugin also commits the current OpenViking session
when session identity is available.

## Tools and commands

When loaded, the plugin registers OpenViking tools for the agent:

| Tool                | Purpose                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `memory_recall`     | Search OpenViking long-term memories.                                                         |
| `memory_store`      | Store important text by appending a short OpenViking session and committing it.               |
| `memory_forget`     | Delete a memory by URI, or search and delete one strong match.                                |
| `ov_archive_search` | Keyword-search archived original messages from the current session.                           |
| `ov_archive_expand` | Expand one archive back into original messages.                                               |
| `add_resource`      | Import a file, directory, URL, Git repository, or uploaded archive into OpenViking resources. |
| `add_skill`         | Import or register an OpenViking skill.                                                       |
| `memory_search`     | Search OpenViking memories, resources, and skills, especially after imports.                  |

It also registers the `openclaw openviking` CLI namespace:

```bash
openclaw openviking setup
openclaw openviking status
```

Use `/add-resource`, `/add-skill`, and `/memory-search` from a chat session when
you want manual imports without asking the model to choose a tool call.

## Relationship to memory backends

OpenViking is not selected through `plugins.slots.memory`. It can still provide
long-term memory behavior because a context engine controls the prompt that the
model actually sees.

| Capability                     | Memory backends                           | OpenViking context engine                            |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| OpenClaw slot                  | `plugins.slots.memory`                    | `plugins.slots.contextEngine`                        |
| Primary job                    | Search, store, and expose memory tools    | Assemble context, compact history, and inject recall |
| Local Markdown memory workflow | Owned by `memory-core`                    | Can run alongside it                                 |
| Session archive and compaction | OpenClaw summaries or backend-specific    | OpenViking archive summaries plus active messages    |
| Automatic recall path          | Memory prompt sections and memory tools   | Context-engine `assemble()` injection                |
| Resource or repo search        | Backend-specific, for example QMD paths   | OpenViking resources and skills                      |
| Best fit                       | Local-first memory and explicit retrieval | Remote archives, multi-agent context, and RAG        |

OpenViking can run alongside the builtin memory plugin. Keep local Markdown
memory when you want OpenClaw's `MEMORY.md` and `memory/*.md` workflow, and use
OpenViking for remote archive-backed context and shared knowledge retrieval.

## Troubleshooting

| Symptom                                             | Check                                                                   | Fix                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `slotActive` is `false`                             | `openclaw config get plugins.slots.contextEngine`                       | Run `openclaw openviking setup --force-slot` only if you intend to replace the current context engine. |
| `health.ok` is `false`                              | `curl <baseUrl>/health` and `openclaw openviking status --json`         | Start or repair the OpenViking server, fix `baseUrl`, or rerun setup with the right API key.           |
| Setup reports a root key needs tenant context       | Status or setup JSON shows `keyProbe.keyType: "root_key"`               | Rerun setup with `--account-id` and `--user-id`, or use a user API key.                                |
| The plugin installs but turns do not use OpenViking | `openclaw plugins inspect openviking --runtime --json` and Gateway logs | Restart the live Gateway process that serves your channels.                                            |
| Recall is empty                                     | `logFindRequests`, OpenViking server logs, and target namespace policy  | Confirm the right `agent_prefix`, user/agent namespace settings, and that memories/resources exist.    |
| `memory_store` commits but extracts zero memories   | OpenViking server extraction and embedding logs                         | Fix server-side model or embedding credentials, then store or commit again.                            |

For a deeper pipeline check from an OpenViking repository checkout, run:

```bash
python examples/openclaw-plugin/health_check_tools/ov-healthcheck.py
```

That check sends a real Gateway conversation and verifies the OpenViking side
captured, committed, archived, and extracted memory.

## Uninstall

```bash
openclaw plugins uninstall openviking
openclaw gateway restart
```

Recent OpenClaw versions reset `plugins.slots.contextEngine` to `legacy` when
the selected context-engine plugin is uninstalled. If you are on an older
OpenClaw build, inspect the slot afterward:

```bash
openclaw config get plugins.slots.contextEngine
```

Set it back to `legacy` if needed.

## Further reading

- [OpenViking OpenClaw integration guide](https://docs.openviking.ai/en/agent-integrations/03-openclaw)
- [OpenViking plugin source](https://github.com/volcengine/OpenViking/tree/main/examples/openclaw-plugin)
- [Context engine](/concepts/context-engine)
- [Memory overview](/concepts/memory)
- [Plugins](/tools/plugin)

## Related

- [Context engine](/concepts/context-engine)
- [Compaction](/concepts/compaction)
- [Memory overview](/concepts/memory)
- [Plugin Architecture](/plugins/architecture)
