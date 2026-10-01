---
summary: "Use the cloud-hosted Agents API harness, powered by Codex, with OpenClaw"
doc-schema-version: 1
read_when:
  - You want to set up Agents API as your OpenClaw agent runtime
  - You want hosted execution with your chat channels, instructions, and tools
title: "Agents API"
---

<a id="agents-api-mvp" />
<a id="agents-api" />

## What is Agents API?

The bundled `agentsapi` plugin replaces OpenClaw's built-in agent harness with
the Agents API harness, which uses the Codex harness under the hood. **The agent
harness runs in OpenAI's cloud.** It manages the conversation and the loop of
calling the model, using tools, and continuing a task.

OpenClaw connects that harness to your chat channels, personal instructions,
memory, and configured tools. You keep interacting with your assistant through
the same channels, with progress, replies, and generated files delivered back to
the conversation.

With the hosted setup in this guide, OpenAI also provides the Linux environment
where your agent runs code and works with files. You can ask it to analyze data,
research a topic, or generate a file, then refine the result through follow-up
messages without provisioning a separate execution machine.

<a id="what-works-with-a-hosted-vm" />

### What you can do

- **Run code and analyze data.** Ask the agent to use Python, Node.js, or shell
  commands to calculate results, process a dataset, or automate a task.
- **Work with files in chat.** Send a document or data file, ask the agent to
  transform it, and download the finished output from its reply.
- **Research and use connected tools.** Combine built-in web search with your
  enabled OpenClaw tools, memory, and connected MCP servers.
- **Keep working through follow-ups.** Refine a result, add another file, or
  redirect work while it is running, all in the same conversation.
- **Keep your assistant's context.** New sessions receive your OpenClaw persona
  and instructions, so the agent can work with your preferences from the start.

The hosted setup is intended for a personal, single-user Gateway. If you want
commands to run on infrastructure you manage, see
[self-hosted execution](/plugins/agentsapi#self-hosted-execution).

## Set up Agents API

Start with a working OpenClaw Gateway and a chat channel. You will also need an
OpenAI API key and a model available to your Agents API project.

### 1. Sign in with an API key

Run:

```bash
openclaw models auth login --provider openai --method api-key
```

Use a key with Agents and Responses read/write plus Models read permission. The
runtime uses the official `https://api.openai.com/v1` endpoint with the
`openai-responses` adapter. See
[OpenAI setup](/providers/openai/setup#getting-started) for authentication help.

### 2. Enable the plugin and choose your model

Merge this into your existing `openclaw.json`, keeping your channel settings and
other plugins. Replace `YOUR_MODEL_ID` in both places with a model available to
your Agents API project.

```json5
{
  plugins: {
    entries: {
      agentsapi: { enabled: true },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/YOUR_MODEL_ID" },
      models: {
        "openai/YOUR_MODEL_ID": { agentRuntime: { id: "agentsapi" } },
      },
    },
  },
}
```

If you use `plugins.allow`, add `agentsapi` and `openai` to that list. Enabling the
plugin makes it available; the model's `agentRuntime` setting selects it for
conversations. See [runtime configuration](/plugins/sdk-agent-harness/runtime-config)
for provider and per-agent model settings.

### 3. Start a conversation and try a task

Apply the configuration through your usual Gateway workflow. In your chat
channel, send `/new`, then try:

> Use Python to calculate the sum of the squares from 1 to 100. Save the result
> to /workspace/outputs/result.txt and send me the file.

Look for the calculation result and download the attached file. This checks the
complete path from your chat to hosted execution and back. You can then upload
your own data or ask the agent to continue the task.

<a id="sessions-and-instructions" />

## Continue a task

Follow-up messages use the same Agents API session. Ask the agent to revise its
answer, work with another attachment, or take the next step. A message sent while
the agent is working can redirect it; stopping the task cancels its remote turn.

New sessions receive your OpenClaw instructions and persona, including
`AGENTS.md`, `SOUL.md`, and your user context. After editing those instructions,
send `/new` or `/reset` to start a conversation with the updated context. Your
enabled memory tools can also search and recall information through the Gateway.

<a id="tools-mcp-and-files" />
<a id="tools%2C-mcp%2C-and-files" />

## Work with files and tools

Attach a file to a message and describe the result you want. For example:

> Summarize this CSV by month and send me a new CSV containing the totals.

Attachments arrive in the agent's hosted workspace. To receive a generated file,
ask the agent to save it under `/workspace/outputs` and return it in the reply.
Download outputs you want to keep: the hosted workspace is separate from your
Gateway's files, and a saved conversation does not guarantee permanent file
storage.

Built-in web search is available in new sessions. Your enabled OpenClaw and
plugin tools remain available under your configured tool policies, including
memory search and recall. You can also connect remote tools through MCP; see
[MCP connections](/plugins/agentsapi#mcp-connections) below.

## Advanced configuration and reference

The sections below cover storage, tool connections, self-hosted execution, and
current limitations. The setup above is enough to start using the hosted
environment.

### Files and storage

Incoming files are placed in `/workspace/inputs`. Files returned with a completed
reply come from `/workspace/outputs`. Transfers support up to 5 MiB per file,
10 MiB total, and 50 files per turn in each direction.

Your Gateway workspace and the hosted filesystem serve different purposes.
Instructions are supplied as context; send files as attachments when the agent
needs their contents in its workspace. See the
[hosted environment guide](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)
for environment lifecycle and storage behavior.

### MCP connections

Configure remote MCP servers in `mcp.servers` or an enabled plugin's MCP bundle
with the `streamable-http` transport. The hosted environment must be able to reach
the server's URL. Supply HTTP authentication headers when required; `localhost`
refers to the hosted environment.

Start a new conversation with `/new` or `/reset` after changing MCP configuration
or credentials. The
[plugin reference](https://github.com/openclaw/openclaw/blob/main/extensions/agentsapi/README.md)
has connection settings, header references, and tool filters.

### Self-hosted execution

For commands on your own infrastructure, configure a self-hosted environment
with an operator-managed executor controller and matching workspace paths.
`hostExecutorSkillDirectories` can expose skill directories installed on that
executor. The
[environment setup reference](https://github.com/openclaw/openclaw/blob/main/extensions/agentsapi/README.md)
covers controller prerequisites, attachment staging, and session resets.

### Session settings and diagnostics

Use `/new` or `/reset` to adopt changes to session instructions, MCP connections,
or reasoning-summary display. These commands start a fresh session on the next
message. Remote history and workspace resources remain managed through the
Agents API.

OpenClaw shows progress and records conversation and tool history in its normal
transcript. Channel settings control progress and reasoning visibility. Token
usage is reported when available from the API; it measures usage rather than
remaining context capacity.

For an end-to-end setup check, use the chat-and-file task above.
`openclaw models status --probe` checks model authentication, not a complete
Agents API session.

<a id="current-limits-and-other-environments" />

### Current limitations

These limits describe the current OpenClaw integration and may change as support
expands.

- **Authentication:** ChatGPT subscription authentication, custom endpoints, and
  authored request transport overrides are not supported by the Agents API
  runtime. Use the API-key setup above.
- **Hosted environment setup:** The plugin does not expose hosted skill
  installation or operator-configured startup commands, packages, environment
  variables, or environment templates. Gateway scripts, repositories, and skill
  directories are not automatically copied into the hosted environment. A
  self-hosted executor must be provisioned by its operator.
- **Instructions and skills:** Changes to workspace instructions or persona need
  a new session. Gateway skill-file access, skill catalog delivery, and plugin
  command prompt registration are not yet supported by this runtime.
- **Agent features:** Native delegation, including `ultra` delegation, and native
  session forks are not supported. Native Codex project discovery, collaboration,
  and deferred tool search do not apply to this runtime.
- **Images and runtime customization:** Image input, image generation, Gateway
  sandbox placement, and custom context engines are not supported.
- **MCP connections:** Stdio, legacy SSE, requester-scoped connections, and custom
  TLS settings are not supported. Gateway OAuth profiles are not forwarded.
  Unsupported definitions are logged and omitted, and a turn can continue without
  an unavailable server.
- **Tool restrictions and hooks:** Policies that restrict native shell, file, or
  web-search capabilities are rejected before a turn starts. Hook `toolsAllow`
  restrictions are not enforced; use another runtime if you depend on those
  per-turn restrictions. Gateway tool policies still apply. Steering and isolated
  completions do not run conversation prompt hooks.
- **History and diagnostics:** Structured plans, diffs, compaction events, native
  child-agent events, and pre-execution approval or hook events are not provided.
  History can be incomplete or out of order while tool results are still arriving.
  Web-search activity is visible without result bodies or snippets. Command exit
  facts can be unavailable, and token usage does not establish remaining context
  capacity.
- **Retries:** OpenClaw can continue the existing session after a transient
  provider failure. It does not automatically replay an admitted turn because
  commands or tools may already have run.
