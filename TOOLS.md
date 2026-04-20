# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

## Slack Channels

When sending messages or referencing channels in Slack, always use the `channel:<ID>` format with the uppercase ID. Never use lowercase IDs or bare channel names like `#corporate-operations`.

| Channel name          | Correct target to use |
| --------------------- | --------------------- |
| #corporate-operations | `channel:C0AB50H2K9R` |
| #vero                 | `channel:C0AC5MSF4PJ` |

For users, always use `user:<ID>` (uppercase Slack user ID, e.g. `user:U01234ABCD`).

---

## Coperniq API

Before making any Coperniq API calls, read the skill file at `skills/coperniq.io/Skill.MD`. It has the full endpoint list, auth instructions, search filter syntax, pagination rules, and examples. The API key is in `$COPERNIQ_API_KEY`.

---

Add whatever helps you do your job. This is your cheat sheet.
