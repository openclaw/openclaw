---
summary: "Frequently asked questions about Clawdis setup, configuration, and usage"
---
# FAQ 🦞

Common questions from the community. For detailed configuration, see [configuration.md](./configuration.md).

## Installation & Setup

### Where does Clawdis store its data?

Everything lives under `~/.clawdis/`:

| Path | Purpose |
|------|---------|
| `~/.clawdis/clawdis.json` | Main config (JSON5) |
| `~/.clawdis/credentials/` | WhatsApp/Telegram auth tokens |
| `~/.clawdis/sessions/` | Conversation history & state |
| `~/.clawdis/sessions/sessions.json` | Session metadata |

Your **workspace** (AGENTS.md, memory files, skills) is separate — configured via `agent.workspace` in your config (default: `~/clawd`).

### What platforms does Clawdis run on?

**macOS, Windows, and Linux!** Anywhere Node.js 22+ runs. The onboarding wizard (`clawdis onboard`) works on all three.

Some features are platform-specific:
- **iMessage** — macOS only (uses `imsg` CLI)
- **Clawdis.app** — macOS native app (optional, gateway works without it)

### I'm getting "unauthorized" errors on health check

You need a config file. Run the onboarding wizard:

```bash
pnpm clawdis onboard
```

This creates `~/.clawdis/clawdis.json` with your API keys, workspace path, and owner phone number.

### How do I start fresh?

```bash
# Backup first (optional)
cp -r ~/.clawdis ~/.clawdis-backup

# Remove config and credentials
rm -rf ~/.clawdis

# Re-run onboarding
pnpm clawdis onboard
pnpm clawdis login
```

### Something's broken — how do I diagnose?

Run the doctor:

```bash
pnpm clawdis doctor
```

It checks your config, skills status, and gateway health. It can also restart the gateway daemon if needed.

---

## Migration & Deployment

### How do I migrate Clawdis to a new machine (or VPS)?

1. **Backup on old machine:**
   ```bash
   # Config + credentials + sessions
   tar -czvf clawdis-backup.tar.gz ~/.clawdis
   
   # Your workspace (memories, AGENTS.md, etc.)
   tar -czvf workspace-backup.tar.gz ~/path/to/workspace
   ```

2. **Copy to new machine:**
   ```bash
   scp clawdis-backup.tar.gz workspace-backup.tar.gz user@new-machine:~/
   ```

3. **Restore on new machine:**
   ```bash
   cd ~
   tar -xzvf clawdis-backup.tar.gz
   tar -xzvf workspace-backup.tar.gz
   ```

4. **Install Clawdis** (Node 22+, pnpm, clone repo, `pnpm install && pnpm build`)

5. **Start gateway:**
   ```bash
   pnpm clawdis gateway
   ```

**Note:** WhatsApp may notice the IP change and require re-authentication. If so, run `pnpm clawdis login` again. Stop the old instance before starting the new one to avoid conflicts.

### Can I run Clawdis in Docker?

There's no official Docker setup yet, but it works. Key considerations:

- **WhatsApp login:** QR code works in terminal — no display needed.
- **Persistence:** Mount `~/.clawdis/` and your workspace as volumes.
- **Browser automation:** Optional. If needed, install headless Chrome + Playwright deps, or connect to a remote browser via `--remote-debugging-port`.

Basic approach:
```dockerfile
FROM node:22
WORKDIR /app
# Clone, pnpm install, pnpm build
# Mount volumes for persistence
CMD ["pnpm", "clawdis", "gateway"]
```

### Can I run Clawdis headless on a VPS?

Yes! The terminal QR code login works fine over SSH. For long-running operation:

- Use `pm2`, `systemd`, or a `launchd` plist to keep the gateway running.
- Consider Tailscale for secure remote access.

---

## Multi-Instance & Contexts

### Can I run multiple Clawds (separate instances)?

The intended design is **one Clawd, one identity**. Rather than running separate instances:

- **Add skills** — Give your Clawd multiple capabilities (business + fitness + personal).
- **Use context switching** — "Hey Clawd, let's talk about fitness" within the same conversation.
- **Use groups for separation** — Create Telegram/Discord groups for different contexts; each group gets its own session.

Why? A unified assistant knows your whole context. Your fitness coach knows when you've had a stressful work week.

If you truly need full separation (different users, privacy boundaries), you'd need:
- Separate config directories
- Separate gateway ports
- Separate phone numbers for WhatsApp (one number = one account)

### Can I have separate "threads" for different topics?

Currently, sessions are per-chat:
- Each WhatsApp/Telegram DM = one session
- Each group = separate session

**Workaround:** Create multiple groups (even just you + the bot) for different contexts. Each group maintains its own session.

Feature request? Open a [GitHub discussion](https://github.com/steipete/clawdis/discussions)!

### How do groups work?

Groups get separate sessions automatically. By default, the bot requires a **mention** to respond in groups.

Per-group activation can be changed by the owner:
- `/activation mention` — respond only when mentioned (default)
- `/activation always` — respond to all messages

See [groups.md](./groups.md) for details.

---

## Context & Memory

### How much context can Clawdis handle?

Claude Opus has a 200k token context window, and Clawdis uses **autocompaction** — older conversation gets summarized to stay under the limit.

Practical tips:
- Keep `AGENTS.md` focused, not bloated.
- Use `/new` to reset the session when context gets stale.
- For large memory/notes collections, use search tools like `qmd` rather than loading everything.

### Where are my memory files?

In your workspace directory (configured in `agent.workspace`, default `~/clawd`). Look for:
- `memory/` — daily memory files
- `AGENTS.md` — agent instructions
- `TOOLS.md` — tool-specific notes

Check your config:
```bash
cat ~/.clawdis/clawdis.json | grep workspace
```

---

## Platforms

### Which platforms does Clawdis support?

- **WhatsApp** — Primary. Uses WhatsApp Web protocol.
- **Telegram** — Via Bot API (grammY).
- **Discord** — Bot integration.
- **iMessage** — Via `imsg` CLI (macOS only).
- **Signal** — Via `signal-cli` (see [signal.md](./signal.md)).
- **WebChat** — Browser-based chat UI.

### Can I use multiple platforms at once?

Yes! One Clawdis gateway can connect to WhatsApp, Telegram, Discord, and more simultaneously. Each platform maintains its own sessions.

### WhatsApp: Can I use two numbers?

One WhatsApp account = one phone number = one gateway connection. For a second number, you'd need a second gateway instance with a separate config directory.

---

## Troubleshooting

### Build errors (TypeScript)

If you hit build errors on `main`:

1. Pull latest: `git pull origin main && pnpm install`
2. Try `pnpm clawdis doctor`
3. Check [GitHub issues](https://github.com/steipete/clawdis/issues) or Discord
4. Temporary workaround: checkout an older commit

### WhatsApp logged me out

WhatsApp sometimes disconnects on IP changes or after updates. Re-authenticate:

```bash
pnpm clawdis login
```

Scan the QR code and you're back.

### Gateway won't start

Check logs:
```bash
cat /tmp/clawdis/clawdis-$(date +%Y-%m-%d).log
```

Common issues:
- Port already in use (change with `--port`)
- Missing API keys in config
- Invalid config syntax (remember it's JSON5, but still check for errors)

---

## Chat Commands

Quick reference (send these in chat):

| Command | Action |
|---------|--------|
| `/status` | Health + session info |
| `/new` or `/reset` | Reset the session |
| `/think <level>` | Set thinking level (off\|minimal\|low\|medium\|high) |
| `/verbose on\|off` | Toggle verbose mode |
| `/activation mention\|always` | Group activation (owner-only) |

---

*Still stuck? Ask in [Discord](https://discord.gg/qkhbAGHRBT) or open a [GitHub discussion](https://github.com/steipete/clawdis/discussions).* 🦞
