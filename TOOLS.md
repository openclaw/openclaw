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

Add whatever helps you do your job. This is your cheat sheet.

### Common Pitfalls

- **Search**: `rg` is missing. Use `grep` instead.
- **Messaging**: When sending a new message (not a reply), you **must** provide `target` or `channelId`.
- **Reactions**: Use only standard emojis (👍, 👎, ❤️, 🔥, 🎉, 💩). Custom or obscure emojis may cause `REACTION_INVALID` errors.
- **Telegram tables**: The system auto-wraps markdown tables in `<pre><code>` via `tableMode: "code"`. Just write normal markdown tables — do NOT manually wrap them in triple backticks (that prevents the table parser from detecting them).
