---
title: "Creating Skills"
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

## ⚠️ Important Gotchas

### Python Virtual Environments

**Do NOT place Python `venv/` directories inside skill folders.** The skill scanner recursively opens all files in the skills directory, and a typical venv contains 10,000+ files. This can exhaust file descriptors and cause the gateway to fail.

**Solution:**
```bash
# Create venvs outside the skills directory
mkdir -p ~/.openclaw/venvs
python3 -m venv ~/.openclaw/venvs/my-skill

# Activate when needed
source ~/.openclaw/venvs/my-skill/bin/activate
```

**Directories to avoid inside skills:**
- `venv/`, `.venv/`, `env/`, `.env/` (Python virtual environments)
- `node_modules/` (already excluded by default)
- `.git/` (version control metadata)
- `__pycache__/` (Python bytecode cache)

For more details, see [GitHub Issue #9921](https://github.com/openclaw/openclaw/issues/9921).

## Shared Skills

You can also browse and contribute skills to [ClawHub](https://clawhub.com).
