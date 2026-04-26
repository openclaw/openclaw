---
name: self-upgrade
description: How Bucky handles requests to update its own behavior, skills, or config via WhatsApp.
user-invocable: false
---

# Self-Upgrade

Dirgh can update Bucky's behavior by messaging him on WhatsApp — no VS Code required for small changes.

## What can be upgraded this way

- Skill rules (greeting policy, capabilities, routing)
- Behavior adjustments ("always say X", "stop doing Y")
- Adding new skills
- Updating PROJECTS.md with new project info

## What cannot be upgraded this way

- Core OpenClaw code changes (those still need VS Code + Claude Code)
- Plugin installation/removal (requires restart)
- Credential/secret changes

## How it works

When Dirgh asks for a behavior change:

1. Recognize it as a self-upgrade request (phrases like "update yourself", "change how you", "fix your X", "add a rule that you should always...", "bucky update your...")
2. Route to Claude Code via `sessions_spawn` with the task:
   ```
   Edit the relevant skill file in deploy/skills/ in the Personal-openclaw repo.
   Project path: /Users/dirghpatel/Documents/Personal-openclaw
   Task: [describe what to change]
   After editing, commit with: FAST_COMMIT=1 scripts/committer "skill: <description>" <files>
   ```
3. Claude Code edits the markdown skill file and commits.
4. bucky-bridge.js auto-syncs deploy/skills/ to GCP ~/.openclaw/skills/ within 60s.
5. Confirm to Dirgh: "Done — I've updated [skill name]. Takes effect in about 60 seconds."

## Trigger phrases

Route to self-upgrade when Dirgh says things like:

- "bucky, update your [X]"
- "stop saying good morning after 12pm"
- "fix how you handle [X]"
- "add a rule that..."
- "change your [greeting/timezone/behavior]"
- "you should always [X]"

## Example

Dirgh: "bucky stop greeting with time-of-day after 9pm"
→ Spawn Claude Code: "Edit deploy/skills/time-context/SKILL.md — update the greeting table to say 9 PM onwards uses 'Hey' or 'Hi' only. Commit."
→ Tell Dirgh: "Done — updated your greeting rules. Effective in ~60 seconds."

## Notes

- Always tell Dirgh what file was changed and what the change was.
- Keep edits minimal — change only what was asked, nothing else.
- If the change is ambiguous, ask one clarifying question before spawning Claude Code.
