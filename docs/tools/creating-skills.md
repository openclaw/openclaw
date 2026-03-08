---
title: "Creating Skills"
summary: "Build and test custom workspace skills with SKILL.md"
read_when:
  - You are creating a new custom skill in your workspace
  - You need a quick starter workflow for SKILL.md-based skills
---

# Creating Custom Skills 🛠

OpenClaw is designed to be easily extensible. "Skills" are the primary way to add new capabilities to your assistant.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file (which provides instructions and tool definitions to the LLM) and optionally some scripts or resources.

## Step-by-Step: Your First Skill

### 1. Create the Directory

Skills live in your workspace, usually `~/.openclaw/workspace/skills/`. Create a new folder for your skill:

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. Define the `SKILL.md`

Create a `SKILL.md` file in that directory. This file uses YAML frontmatter for metadata and Markdown for instructions.

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Add Tools (Optional)

You can define custom tools in the frontmatter or instruct the agent to use existing system tools (like `bash` or `browser`).

### 4. Refresh OpenClaw

Ask your agent to "refresh skills" or restart the gateway. OpenClaw will discover the new directory and index the `SKILL.md`.

## Best Practices

- **Be Concise**: Instruct the model on _what_ to do, not how to be an AI.
- **Safety First**: If your skill uses `bash`, ensure the prompts don't allow arbitrary command injection from untrusted user input.
- **Test Locally**: Use `openclaw agent --message "use my new skill"` to test.

## Next Steps

The guide above covers the basics. The full [Skills Reference](./skills.md) documents several advanced features you will likely need as your skill matures:

- **Conditional activation** — Use `requires.bins`, `requires.env`, or `requires.config` in your skill's metadata to gate loading so the skill only appears when its dependencies are present. See [Gating](./skills.md#gating-load-time-filters).
- **Environment & API key injection** — Supply secrets to your skill at runtime via `skills.entries.<name>.env` and `apiKey` in `openclaw.json`, scoped to a single agent run. See [Environment injection](./skills.md#environment-injection-per-agent-run).
- **Command dispatch** — Set `command-dispatch: tool` and `command-tool` in frontmatter to bypass the model and route a slash command directly to a tool. See [Format](./skills.md#format-agentskills--pi-compatible).
- **Template variables** — Use `{baseDir}` inside your `SKILL.md` instructions to reference the skill's own directory, keeping paths portable across machines. See [Format](./skills.md#format-agentskills--pi-compatible).
- **Invocation control** — Set `user-invocable: false` to hide a skill from the slash-command menu, or `disable-model-invocation: true` to prevent the model from using it autonomously. See [Format](./skills.md#format-agentskills--pi-compatible).
- **Config overrides** — Toggle skills on/off and pass custom per-skill configuration via `skills.entries` in `openclaw.json`. See [Config overrides](./skills.md#config-overrides-openclawopenclaw-json).

## Shared Skills

You can also browse and contribute skills to [ClawHub](https://clawhub.com).
