---
name: dj-mode
description: Switch between personal and work-safe chat routing modes.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔀",
        "commands": [{ "name": "mode", "description": "Switch personal/worksafe mode" }],
      },
  }
---

# dj-mode

Switch between DJ-Personal and DJ-WorkSafe assistant modes, or get guidance on which to use.

## Usage

```
/mode
/mode personal
/mode worksafe
/mode status
```

## Modes

### Personal Mode (DJ-Personal)

Full-featured assistant with access to:
- Google Calendar (read/write proposals)
- Gmail (read, write with approval)
- All Notion databases (Tasks, Projects, Meetings, Podcast, Research)
- Full context about DJ career and personal life

Use when:
- Working from home/studio
- Private conversation
- Managing DJ business
- Creative work

### WorkSafe Mode (DJ-WorkSafe)

Restricted assistant with:
- Calendar read-only
- Work notes database only
- No personal/DJ context
- Local LLM (LM Studio) - no cloud API calls

Use when:
- At day job
- Shared screen/shoulder surfers
- Work laptop
- Need privacy from cloud services

## Implementation

### Check Current Mode

Read from session or config:

```
Current mode: Personal (DJ-Personal agent)
```

### Switch Mode

Mode switching works via agent routing. Options:

**Option 1: Session-based routing**
Tell user to message a different bot/channel that's configured for the other agent.

**Option 2: Binding switch**
If using agent bindings, update the binding for this chat:

```json
{
  "agentId": "dj-worksafe",
  "match": {
    "channel": "telegram",
    "peer": { "kind": "dm", "id": "123456" }
  }
}
```

**Option 3: Guidance**
Provide instructions for switching:

```
🔀 **Mode Switching**

You're currently in **Personal** mode.

To switch to **WorkSafe** mode:
1. Message @YourWorkSafeBot on Telegram, or
2. Use the work-safe chat thread, or
3. Run `openclaw config set agents.bindings.[...].agentId dj-worksafe`

To switch back to **Personal**:
1. Message @YourPersonalBot on Telegram, or
2. Use the personal chat thread
```

## Status Output

```
🔀 **Current Mode: Personal**

Agent: dj-personal (Cue ⚡)
Model: anthropic/claude-opus-4-5
Tools: Calendar, Email, Notion (full), Browser (disabled)

Available modes:
• personal - Full assistant (current)
• worksafe - Restricted, local LLM

Switch with: /mode worksafe
```

## Configuration

Agent configurations in `openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "dj-personal",
        "default": true,
        "workspace": "workspaces/dj-personal",
        "model": { "primary": "anthropic/claude-opus-4-5" },
        "tools": {
          "browser": { "enabled": false }
        }
      },
      {
        "id": "dj-worksafe",
        "workspace": "workspaces/dj-worksafe",
        "model": { "primary": "lmstudio/local-model" },
        "tools": {
          "browser": { "enabled": false },
          "email": { "enabled": false }
        }
      }
    ]
  }
}
```

## Notes

- Mode is per-chat, not global
- WorkSafe mode doesn't have memory of Personal mode conversations
- Can't access Personal databases from WorkSafe mode (separate workspaces)
- LM Studio must be running for WorkSafe mode to work
