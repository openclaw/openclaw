---
summary: "Primary operational context: capabilities, heartbeat, when to ask for help, Docker/write rules; agent may append under the last section"
read_when:
  - Starting a session or when in doubt about where to write or when to notify the operator
---

# Agent operating procedures

This file is **primary operational context** for the agent: follow it for day-to-day behavior, where you can write, when to ask for help, and how to stay on track.

---

## Where to learn your capabilities

- **System prompt (each session)** – Your **skills** and **tools** are listed in the system prompt you receive at the start of every session:
  - **Skills:** A block `<available_skills>` lists skill names, short descriptions, and paths. When one clearly applies, read its **SKILL.md** with the `read` tool at the given path, then follow it. Do not infer skills from TOOLS.md.
  - **Tools:** The "## Tooling" section lists every enabled tool by name and one-line summary. Use those names exactly when calling tools.
- **TOOLS.md** – **Does not** control which tools or skills you have. It is **operator-written guidance** for your setup (e.g. camera names, SSH hosts, TTS preferences, device nicknames). Use it for environment-specific notes; the authoritative lists of what you can do are in the system prompt.
- **WORKSPACE_RULES.md** – What you can and cannot edit; GitHub PR workflow; read-only vs mutable files; safe collaboration flow.
- **HEARTBEAT.md** – Periodic tasks. Use it to keep yourself on track for current medium/long-running goals.
- **BOOT.md** – Startup checklist (when the gateway runs a boot check).
- **CLI / commands** – Any documented CLI or command patterns are in TOOLS.md or workspace docs. Use only allowed commands and safe working directories (see below).

---

## Staying on track

- **Use your heartbeat** to keep yourself aligned with current tasks. When you have ongoing work, record it in HEARTBEAT.md (or the equivalent your operator has set up) and review it periodically so you don’t lose the thread.

---

## When you’re stuck

- **Try by yourself first.** Use retries, different approaches, and the docs/tools you have.
- **After a reasonable number of attempts** (e.g. on the order of ~10 retries or clear failures), **notify the operator** (the human). Say what you tried and what’s blocking you; ask for direction or unblocking.
- **If the operator doesn’t respond within about an hour**, assume they may be asleep or away. **Try again later with a fresh retry count** rather than repeating the same failing step indefinitely. You can note the issue in memory or HEARTBEAT and retry when you next run.

---

## Docker and where you can write

- **You run inside a Docker container.** You can **read** the codebase and workspace, but **writes are only allowed to shared volumes** (paths the container mounts as writable).
- **Safe places to write:** the workspace (e.g. under `/state/.openclaw/workspace`), memory files, and **`/repos`** (the agent clone area). Do not try to write outside these; writes will fail or be ignored.
- **Clone and work with GitHub repos in `/repos`.** That directory is mounted from the host and is writable. Use it for cloning repos, running builds, or scratch work so the main workspace stays clean. Do not clone into the immutable workspace root; use `/repos/<repo-name>` instead.

---

## More operational context

- Additional procedures (e.g. escalation, special workflows, or operator preferences) may be added here over time. Re-read this file when your operator updates it or when in doubt.

---

## Agent-maintained notes (you may edit this section)

Add items below. Use this for current tasks, heartbeat reminders, or other operational notes you want to keep in this file. Do not remove the heading; append under it.

- (none yet)
