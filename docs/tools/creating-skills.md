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

## Advanced Features

Once you've created a basic skill, you can enhance it with these advanced features:

- **Conditional activation**: Use `requires.bins`, `requires.env`, or `requires.config` to gate your skill — [see Skills Reference](./skills.md#gating)
- **API key injection**: Skills can receive API keys and environment variables via the `apiKey` field — [see Skills Reference](./skills.md#env-injection)
- **Multi-command skills**: Use `command-dispatch` for skills with multiple subcommands — [see Skills Reference](./skills.md#command-dispatch)
- **Template variables**: Use `{baseDir}` and other templating for portable paths — [see Skills Reference](./skills.md#template-variables)
- **Invocation control**: Control when your skill can be invoked with `user-invocable` and `disable-model-invocation` flags — [see Skills Reference](./skills.md#invocation-control)
- **Testing strategies**: Run `openclaw skill test <name>` to validate your skill locally — [see Skills Reference](./skills.md#testing)

For a complete reference of all supported SKILL.md frontmatter fields, see the [Skills Reference](./skills.md#frontmatter-reference).

## Shared Skills

You can also browse and contribute skills to [ClawHub](https://clawhub.com).
