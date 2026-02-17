---
name: agent-manager
description: Manage and orchestrate multiple OpenClaw agents. Use when the user wants to assign tasks to agents, check agent status, switch agent modes (creative, research, auto), list running agents, or coordinate multi-agent workflows. Triggers for "give agent X this task", "what are my agents doing", "switch to creative mode", "assign this to the researcher", "agent status", or "run this with the coder".
metadata: { "openclaw": { "emoji": "🎛️" } }
---

# Agent Manager

Orchestrate multiple agents, assign tasks, check status, and switch modes.

## Available Agents

| Agent ID     | Role                                              | Model     | Skills                                         |
| ------------ | ------------------------------------------------- | --------- | ---------------------------------------------- |
| `commander`  | Orchestrator - routes tasks, coordinates agents   | Kimi K2.5 | All skills, sub-agent access                   |
| `researcher` | Research & Analysis - scans web, X.com, trends    | Kimi K2.5 | research-scout, web_search, web_fetch, browser |
| `creator`    | Content Creation - blogs, media, creative writing | Kimi K2.5 | blog-publisher, creative-mode, canvas          |
| `deployer`   | Site & App Deployment                             | Kimi K2.5 | site-deployer, coding-agent, github            |
| `voice`      | Voice Cloning & TTS                               | Kimi K2.5 | voice-clone, sherpa-onnx-tts                   |

## Assigning Tasks

Use `sessions_spawn` to delegate tasks to specific agents:

```
sessions_spawn task:"Write a blog post about AI agent workflows" agentId:"creator"
sessions_spawn task:"Research latest AI tools on X.com" agentId:"researcher"
sessions_spawn task:"Deploy the blog to Vercel" agentId:"deployer"
sessions_spawn task:"Clone this voice sample" agentId:"voice"
```

## Checking Status

```
# List all available agents
agents_list

# Check what sessions are running
# Look for active sub-agent sessions in the response
```

## Multi-Agent Workflows

### Blog Pipeline (Research -> Write -> Deploy)

```
1. sessions_spawn task:"Research trending AI topics on X.com and save a summary to ~/workspace/research/topics.md" agentId:"researcher"
2. sessions_spawn task:"Read ~/workspace/research/topics.md and write a blog post. Save to ~/blog/content/" agentId:"creator"
3. sessions_spawn task:"Deploy the blog at ~/blog/ to Vercel" agentId:"deployer"
```

### Creative Sprint

```
sessions_spawn task:"Enter creative mode. Generate 5 social media posts about our latest AI features. Save to ~/workspace/content/social/" agentId:"creator"
```

### Research Digest

```
sessions_spawn task:"Scan X.com for the latest AI agent frameworks, coding tools, and automation hacks. Compile a digest with links and key takeaways. Save to ~/workspace/research/daily-digest.md" agentId:"researcher"
```

## Mode Switching

Tell the commander to switch an agent's behavior:

- **Creative Mode**: "Switch creator to creative mode" - agent generates content autonomously with high creativity
- **Research Mode**: "Put researcher in deep scan mode" - thorough multi-source research
- **Auto Mode**: "Let agents find their own work" - agents use cron + research to propose tasks
- **Focused Mode**: "Focus deployer on the blog project only" - single-task focus

## Autonomous Work Proposals

When agents find potential tasks, they submit proposals via `sessions_send`:

```
sessions_send agentId:"commander" message:"[PROPOSAL] Found trending topic: 'AI Agent Frameworks 2026'. Shall I write a blog post about it? Estimated: 1 blog post + 3 social media snippets."
```

The commander will relay proposals to you for approval.

## Resource Management

- Sub-agents run with `maxConcurrent: 4` to avoid Mac overload
- Default model is Kimi K2.5 (free, low resource usage)
- Agents auto-archive after 60 minutes of inactivity
- Use `thinking: "low"` for routine tasks, `thinking: "medium"` for complex ones

## Quick Commands

| Command         | What it does                                 |
| --------------- | -------------------------------------------- |
| "Status"        | List all agents and their current state      |
| "Research X"    | Send topic to researcher agent               |
| "Blog about X"  | Send topic to creator agent                  |
| "Deploy X"      | Send project to deployer agent               |
| "Creative mode" | Switch creator to autonomous creative output |
| "What's new?"   | Ask researcher for latest findings           |
| "Pause all"     | Suspend all running sub-agents               |
