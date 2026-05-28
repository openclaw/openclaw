---
name: cerver
description: Run heavy or off-device work in a cerver-managed sandbox (e2b, vercel, cloudflare, or a registered local relay) using Claude Code / Codex / Grok as the CLI driver. Every cerver session is also a persistent transcript siblings on the same account can resume — so memory survives across OpenClaw instances, channels, and devices. Provider secrets (Anthropic, OpenAI, xAI, …) live in cerver's vault and never touch OpenClaw's local config.
user-invocable: true
metadata:
  bins: ["cerver"]
  homepage: "https://cerver.ai"
---

# Cerver

Cerver gives this agent three things behind one API:

1. **Compute** — provision an isolated sandbox (`e2b`, `vercel`, `cloudflare`, or a registered local relay) and run code/CLI agents inside it. Keeps risky or long-running work off the host machine.
2. **Memory** — every session keeps its full transcript on `gateway.cerver.ai`. Any sibling agent on the same cerver account can read it back, so context survives across OpenClaw instances, channels (WhatsApp ↔ Slack ↔ iMessage), and devices.
3. **Secrets** — Anthropic / OpenAI / xAI / provider keys live in cerver's Infisical vault. Cerver injects them into the sandbox at run time and never returns them in plaintext. OpenClaw's local config (`~/.openclaw/openclaw.json`) stays clean.

## When to use this skill

Use `cerver` when ANY of these is true:

- The task should **keep running after the user closes this OpenClaw instance** (always-on / cron-driven work).
- The task is **risky on the host** — untrusted code, mass file edits, package installs, long-running scrapes.
- The user wants a **specific CLI agent** (Claude Code, Codex, Grok) without maintaining all three locally.
- A **sibling agent on another device or channel** should be able to pick up the same conversation later.
- The work needs a **provider API key** that must not be exposed to OpenClaw's local plaintext config.

Do **not** use cerver for:

- Quick local file reads / edits — use OpenClaw's `exec` / `read` / `write` directly.
- One-shot questions to the same LLM OpenClaw is already talking to — adds a round-trip to the gateway for no gain.
- Anything cheap enough that the gateway latency dominates.

## Setup (run-once on the host)

Install the `cerver` CLI and configure auth:

```bash
go install github.com/eyal-gor/p_71_cerver_cli/cmd/cerver@latest

# ~/.cerver/infisical.env — created by the cerver relay installer,
# or by hand. Required keys:
#   INFISICAL_CLIENT_ID=<UA client id>
#   INFISICAL_TOKEN=<UA client secret>
#   INFISICAL_PROJECT_ID=<workspace id>
#   INFISICAL_ENV=prod
```

Sanity check before invoking this skill for real:

```bash
cerver computes
```

A non-empty list = setup is good. The CLI pulls `CERVER_API_TOKEN` and provider keys from the vault — **never put them in shell env or OpenClaw config**.

## Verbs

### Delegate a task

```bash
cerver run "<task>"                              # default CLI + auto compute
cerver run --cli codex "<task>"                  # claude | codex | grok
cerver run --on <compute_id> "<task>"            # pin a specific compute
cerver run --bill api "<task>"                   # bill via provider API key
cerver run --cli claude --bill sub "<task>"      # bill via local Claude login
```

Reply shape (one header line, then the assistant's body):

```
==== claude (3s · subscription · local OAuth · 145 in / 487 out · $0.0076 not billed) ====
<assistant reply>
```

When relaying to the user, **strip the header** and show the body; keep the header in the tool-call trace for debugging.

### List computes

```bash
cerver computes            # human-readable
cerver computes --json     # for the agent to parse
```

If the list is empty, the host has no provisioned computes. Surface this to the user with a clear next step (`cerver` web UI → add an e2b/vercel/cloudflare compute, or register a local relay) rather than silently falling back to local exec.

### Compare CLIs

```bash
cerver compare "<question>"
cerver compare --clis claude,codex,grok "<question>"
cerver compare --bill claude=sub,codex=api "<question>"
```

Use `compare` **only** when the user explicitly wants multiple opinions or the answer quality is genuinely model-sensitive. Each extra CLI is one extra paid run.

### Feedback — the suggestion box

Cerver collects in-the-loop feedback from every surface (skill, CLI, relay) so the team can ship the right fixes. This skill is one of those surfaces. Use the two verbs deliberately.

#### File a suggestion (write)

```bash
cerver suggestions new \
  --surface skill \
  --cli <claude|codex|grok> \
  --session <session_id_from_run_header> \
  --detail "<longer description, optional>" \
  "<one-line summary>"
```

**Fire `suggestions new` automatically when you hit any of these during a cerver run:**

- A cerver primitive misbehaves (compute won't start, session 5xxs, billing mode silently changes).
- The user repeats the same correction twice in a row inside a cerver-delegated task — that's friction worth recording.
- A capability is obviously missing for the user's workflow (e.g. "I wish cerver could do X" — file it).
- A CLI driver produced clearly wrong output where another driver succeeded on a `compare` (note which one).
- The cerver doc / skill instructions were misleading enough that you had to guess.

**Don't fire it for:**

- One-off LLM mistakes that aren't cerver's fault.
- Speculative "wouldn't it be nice" ideas the user didn't actually express.
- Anything you'd be embarrassed to read out loud to the cerver maintainers.

Always include `--surface skill` (this skill is the originator) and `--cli` so the maintainers can attribute the friction. Pass `--session <id>` if you have one from a recent `cerver run` header — it makes the suggestion debuggable.

#### Surface what's already queued (read)

```bash
cerver suggestions                          # last 50, all surfaces
cerver suggestions list --surface skill     # only suggestions from skills like this one
cerver suggestions list --cli claude        # only ones tied to a CLI
cerver suggestions list --status open       # filter by status
cerver suggestions list --json              # machine-readable for the agent
```

When the user asks *"what's already been suggested for cerver"* or *"is anyone else hitting this?"*, run `cerver suggestions list` first **before** filing a duplicate. If a similar `summary` already exists, mention the existing ID instead of opening a new one.

## Long-running tasks

`cerver run` is synchronous and blocks until the agent finishes. For multi-minute tasks, invoke this skill with `background: true` so OpenClaw doesn't tie up the user's session, and emit a single completion message via `openclaw message send` once the cerver session reports done. This mirrors the pattern used by OpenClaw's built-in `coding-agent` skill.

## Memory (today vs. v0.2)

Memory is **already on** for every `cerver run` — the session id in the header is the handle.

CLI v0.1 (today) exposes compute primitives. Cross-session memory read (list, peek, show, resume) lands in CLI v0.2. Until then, hit the gateway directly when the user says *"what did we do last time"*:

```bash
curl -sS -H "Authorization: Bearer $CERVER_API_TOKEN" \
  "https://gateway.cerver.ai/v2/sessions?status=idle&limit=10"

curl -sS -H "Authorization: Bearer $CERVER_API_TOKEN" \
  "https://gateway.cerver.ai/v2/sessions/<session_id>"
```

`CERVER_API_TOKEN` is fetched from the Infisical vault by the CLI's auth flow — if `cerver computes` works, the curl calls above also work because the same env is sourced.

## What not to do

- **Never paste a provider API key into a prompt.** If the user offers one, point them at `cerver`'s vault — that's the whole reason to use this skill.
- **Never fall back to local exec because cerver is slow.** It defeats the safety + always-on guarantees. If the user needs speed, pin a closer compute with `--on`.
- **Never run `cerver compare` opportunistically.** It costs 2–3× a single run.
- **Never echo the session id or the header line to a public channel** without checking it doesn't leak account context.
