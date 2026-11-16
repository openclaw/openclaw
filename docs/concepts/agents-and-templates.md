---
summary: "When to make a new agent, how to give it a job, and how to package it as a Template"
read_when:
  - Deciding whether a job deserves its own agent
  - Setting up a new agent with instructions, skills, tools, and a schedule
  - Packaging an agent as a Template or starting from someone else's Template
title: "Agents and Templates"
---

An agent is something you give a job to. Each agent has its own workspace,
instructions, and session history, so it can keep doing that job without you
explaining it again.

A Template is that agent packaged so someone else can start with it. It carries
the setup for the job and leaves your history behind.

This page is a short guide to both. Each section links to the reference page
that has the full details.

## When to make a new agent

OpenClaw starts with one agent, and one agent can do a wide range of work. A
second agent is worth making when a piece of work stands apart:

- You keep asking for the same work, and you explain it again each time.
- The work has its own instructions, tools, or schedule that the rest of your
  work does not need.
- You want the agent to build up context on one job. Each agent keeps its own
  workspace, memory files, and sessions, so what it learns about the job stays
  with the job instead of mixing into your main agent's context.

Jobs from engineering and developer relations that fit this description
include:

- Working through contributor pull requests and leaving a first review.
- Watching a project's dependencies for new security advisories.
- Monitoring mentions of a project and summarizing what needs a reply.
- Turning a recording into clips and show notes.

A one-off task does not need its own agent. Ask the agent you already have.

To make an agent in the Control UI, choose **Create new agent** in the agent
selector and give it a name. From the command line:

```bash
openclaw agents add pr-review --workspace ~/.openclaw/workspace-pr-review
```

An agent can also serve a separate person, persona, or channel account. See
[Multi-agent routing](/concepts/multi-agent) for that setup, and
[`openclaw agents`](/cli/agents) for every creation option.

## Give the agent its job

A new agent has a name and a workspace, but no job yet. Four things define the
job:

- Instructions say what the job is and where it stops. They are Markdown files
  in the agent's workspace: `AGENTS.md` holds operating instructions, and
  `SOUL.md` holds persona, tone, and boundaries. Describe what the agent should
  produce, what it must leave alone, and when it should ask you first. See
  [Agent workspace](/concepts/agent-workspace).
- Skills are the steps the agent should follow each time. A skill is a folder
  with a `SKILL.md` file, and a skill in the workspace `skills/` directory is
  visible only to that agent. See [Skills](/tools/skills) and
  [Creating skills](/tools/creating-skills).
- Plugins and MCP servers are the tools and services the job needs, such as a
  chat channel, web search, or a third-party service. They are installed on the
  Gateway and shared between agents, and per-agent tool policy can restrict
  what each agent may use. See [Plugins](/tools/plugin),
  [Connect MCP servers](/tools/mcp), and
  [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools).
- Automations are when the agent runs without being asked. An automation is a
  scheduled job assigned to an agent. See [Automations](/automation/cron-jobs).

For example, this automation asks the `pr-review` agent to do its job every
weekday at 09:00:

```bash
openclaw automations create "0 9 * * 1-5" \
  "Review contributor pull requests opened since the last run." \
  --name "Pull request review" \
  --agent pr-review
```

It helps to run a job by hand a few times before scheduling it, so you know
what the output looks like. When you ask for the same job several times, the
agent can offer to turn it into an automation.

## Package it as a Template

Once an agent does its job well, you can package it so other people can start
from the same setup. Templates are an experimental feature. Enable **Templates**
in **Settings → Labs** first, or set `gateway.controlUi.experimental.templates`
to `true` on a headless installation.

A Template can include agent instructions, workspace files, skills, plugins,
MCP servers, and automations. It does not include your memories, conversations,
or credentials. A setting that needs a secret, such as an MCP server token, is
declared as an environment variable reference and never as a value.

The agent can prepare the Template itself. The review opens in the Control UI
and needs an administrator connection.

1. In the agent's chat, ask it to "create a new template from this agent." The
   agent drafts a private proposal and opens a review card in the same
   conversation. It writes the proposal for a new owner instead of copying your
   workspace.
2. Review what it prepared. The card shows the exact files in the package and
   the skills, plugins, MCP servers, and automations it declares. The review is
   read-only, so ask the agent to revise the proposal when something should
   change. Known private paths and credential-like text are rejected, but read
   the remaining text for personal details yourself.
3. Publish it to ClawHub so others can add it. Sign in with `clawhub login` on
   the Gateway host, then select **Publish** on the review card. Publishing is
   your decision; the agent cannot publish for you. The card shows **Pending**
   while ClawHub checks the submission and **Published** once the Template is
   available, with a link you can share.

You can also write a Template by hand. See
[Templates](/cli/templates#author-locally) for the package format.

## Start from someone else's Template

Published Templates live on [ClawHub](/clawhub). Enable **Templates** in
**Settings → Labs**, then open **Templates** under **Pages** in the Control UI
to browse and search them. With the same switch on, you can also add a Template
from the command line when someone shares its ClawHub reference:

```bash
openclaw templates add @<publisher>/<slug>
```

Adding a Template creates an ordinary agent that is yours to change. Add is a
one-way action: there is no installed Template to update or remove afterward,
and adding the same Template again creates another agent. Edit the new agent's
instructions, skills, and automations as you would for an agent you made
yourself, and delete it like any other agent.

Review what a Template installs before you add it, because its instructions
and requirements come from another author. In the Control UI, open the Template
to read its workspace files and see its skills, plugins, MCP servers, and
automations. **Add** creates the agent right away, so read those details first.
A Template that ClawHub flagged for review shows a warning and asks you to
confirm. From the command line, preview without creating anything:

```bash
openclaw templates add @<publisher>/<slug> --dry-run --json
```

When you add from the Control UI, the new agent's first reply lists what still
needs you, such as signing in to an MCP server or enabling an automation.

## Related

- [Templates](/cli/templates) - package format and the `openclaw templates` commands
- [`openclaw agents`](/cli/agents) - create, list, and delete agents
- [Multi-agent routing](/concepts/multi-agent) - isolation, channel accounts, and bindings
- [Agent workspace](/concepts/agent-workspace) - the files that hold an agent's instructions
- [Skills](/tools/skills) - how skills load and who can see them
- [Plugins](/tools/plugin) - install and configure plugins
- [Connect MCP servers](/tools/mcp) - add MCP servers and verify them
- [Automations](/automation/cron-jobs) - schedule work for an agent
- [Experimental features](/concepts/experimental-features) - what Labs switches control
