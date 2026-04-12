---
title: "Community Skills"
summary: "Community-contributed skills for OpenClaw and Claude Code"
read_when:
  - You want to discover skills built by the community
  - You need security, memory, or communication tools
---

# Community Skills

These skills are contributed by the community and extend OpenClaw with security tooling, shared memory systems, and inter-agent communication.

## 🔒 Security Suite

### safe-skill-install
**Author:** nerua1  
**Repo:** https://github.com/nerua1/safe-skill-install

Secure skill installation pipeline with automatic security auditing. Before installing any skill from ClawHub, this tool:
- Audits the skill for security issues
- Automatically rewrites suspicious but fixable skills
- Rejects skills with critical red flags (curl | bash, credential exfiltration, etc.)

```bash
# Use before installing any skill
/safe-skill-install skill-name
```

### skill-vetter
**Author:** nerua1  
**Repo:** https://github.com/nerua1/skill-vetter

Manual security vetting protocol for reviewing skills before installation. Provides detailed reports on:
- Code analysis for red flags
- Permission scope evaluation
- Risk classification (LOW/MEDIUM/HIGH/EXTREME)
- Trust hierarchy assessment

```bash
# Vet a skill before installing
/skill-vetter analyze skill-name
```

## 🧠 Memory & Architecture

### shared-memory-stack
**Author:** nerua1  
**Repo:** https://github.com/nerua1/shared-memory-stack

Complete shared memory architecture connecting multiple agents (Claude Code, OpenClaw/Kimi, LM Studio subagents) through:
- **Obsidian vault** for structural knowledge (wiki, daily notes, ideas)
- **MemPalace (ChromaDB)** for semantic search and RAG
- **capture-idea pipeline** for saving insights from any agent
- Automatic mining and indexing of all vault content

```bash
# Load the skill to understand the architecture
/skill shared-memory-stack

# Capture an idea from any session
capture-idea --title "OAuth issue" --topic security --tags "oauth,mobile"
```

## 🌉 Communication

### openclaw-bridge
**Author:** nerua1  
**Repo:** https://github.com/nerua1/openclaw-bridge

Agent-to-agent messaging enabling Claude Code to communicate with OpenClaw/Kimi via the local gateway. Use for:
- Delegating tasks between agents
- Getting second opinions from different models
- Handing off context between sessions
- Triggering OpenClaw skills from Claude Code

```bash
# From Claude Code: ask OpenClaw
/ask-openclaw "Is this SQL migration safe?"
```

## 🚀 Developer Tools

### publish-skill
**Author:** nerua1  
**Repo:** https://github.com/nerua1/publish-skill

Publish your OpenClaw skills to GitHub. Configured for the nerua1 account with SSH keys and gh CLI.

```bash
# Publish a skill
/publish-skill my-skill-name
```

## Installing Community Skills

All community skills can be installed directly from GitHub:

```bash
# Clone to your workspace
cd ~/.openclaw/workspace/skills
git clone https://github.com/nerua1/skill-name.git

# Or use the OpenClaw skill tool
openclaw skills install nerua1/skill-name
```

## Contributing

To contribute your own skills:
1. Create a skill following the [Creating Skills](/tools/creating-skills) guide
2. Test thoroughly in your workspace
3. Publish to GitHub
4. Open a PR to add it to this list

---

*Community skills are not officially maintained by OpenClaw. Always review code before installing.*