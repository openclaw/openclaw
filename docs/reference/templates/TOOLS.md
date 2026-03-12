---
title: "TOOLS.md Template"
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Environment

- **Server:** _(e.g. AWS EC2, local machine, VPS)_
- **OS:** _(e.g. Ubuntu 24.04 ARM64, macOS)_
- **IP:** _(internal/external as needed)_
- **Runtime:** _(e.g. Node.js v22, Python 3.12)_

## Projects

_(List active projects and their key details)_

- **project-name** — short description, special rules or conventions

## What Else Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- API endpoints or service URLs
- Anything environment-specific

## Examples

```markdown
### SSH

- prod-server → 10.0.0.1, user: deploy
- staging → 10.0.0.2, user: deploy

### Services

- Config: ~/.openclaw/openclaw.json
- Auth: ~/.openclaw/agents/main/agent/auth-profiles.json
- Workspace: ~/workspace/

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
