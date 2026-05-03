---
title: "Community Skills"
summary: "Community-contributed skills for OpenClaw"
read_when:
  - You want to discover skills built by the community
  - You need security, memory, or communication tools
---

# Community Skills

Community-maintained skills that extend OpenClaw with security tooling, shared memory systems, and inter-agent communication.

> This directory is seeded to bootstrap the community. PRs adding skills from diverse authors are welcome.

## 🔒 Security

### safe-skill-install
**Author:** nerua1  
**Repo:** https://github.com/nerua1/safe-skill-install

Security-first skill installer. Audits every skill before installation:
- Code analysis for red flags (curl | bash, credential exfiltration, etc.)
- Automatic rewrite of fixable issues
- Hard rejection of critical risks

```bash
/safe-skill-install skill-name
```

### skill-vetter
**Author:** nerua1  
**Repo:** https://github.com/nerua1/skill-vetter

Manual security review protocol. Produces detailed reports:
- Red flag analysis
- Permission scope evaluation
- Risk classification (LOW/MEDIUM/HIGH/EXTREME)
- Trust hierarchy assessment

```bash
/skill-vetter analyze skill-name
```

## 🧠 Memory & Architecture

### shared-memory-stack
**Author:** nerua1  
**Repo:** https://github.com/nerua1/shared-memory-stack

Multi-agent shared memory architecture connecting Claude Code, local LLM assistants, and OpenClaw through:
- **Obsidian vault** for structured knowledge (wiki, daily notes, ideas)
- **MemPalace (ChromaDB)** for semantic search and RAG
- **capture-idea pipeline** for cross-agent insight capture
- Automatic mining and indexing of vault content

```bash
/skill shared-memory-stack

capture-idea --title "OAuth issue" --topic security --tags "oauth,mobile"
```

## 🌉 Communication

### openclaw-bridge
**Author:** nerua1  
**Repo:** https://github.com/nerua1/openclaw-bridge

Agent-to-agent messaging for Claude Code to communicate with OpenClaw and other local agents:
- Delegate tasks between agents
- Request second opinions from different models
- Hand off context between sessions
- Trigger OpenClaw skills from Claude Code

```bash
/ask-openclaw "Is this SQL migration safe?"
```

## Installing Community Skills

```bash
cd ~/.openclaw/skills
git clone https://github.com/nerua1/skill-name.git

# Or via the OpenClaw CLI
openclaw skills install nerua1/skill-name
```

## Contributing

1. Create a skill following the [Creating Skills](/tools/creating-skills) guide
2. Test thoroughly in your workspace
3. Publish to GitHub
4. Open a PR adding it to this page

---

*Community skills are not officially maintained by OpenClaw. Always review code before installing.*
