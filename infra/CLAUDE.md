# Infra / Fleet Deployment Guidelines

## MANDATORY: Read Before Touching Anything

Before making ANY infra/deployment changes, READ these docs. Not skim. READ.

### Required reading (in order):
1. `docs/concepts/architecture.md` — how OpenClaw works
2. `docs/concepts/agent-workspace.md` — workspace file layout (SOUL.md, AGENTS.md, TOOLS.md, USER.md, MEMORY.md and what each is for)
3. `docs/concepts/system-prompt.md` — how the system prompt is assembled
4. `docs/concepts/memory.md` — memory system architecture
5. `docs/concepts/model-providers.md` — provider/auth/OAuth system
6. `docs/gateway/configuration.md` — config file structure
7. `docs/gateway/configuration-reference.md` — every config field
8. `docs/gateway/secrets.md` — secrets/credentials management
9. `docs/superpowers/specs/2026-03-25-base-platform-migration-design.md` — the migration spec

### Also read the RUNNING STATE before editing:
- `ssh gateway 'cat /home/jeff/.openclaw/openclaw.json'` — current config
- `ssh gateway 'cat /home/jeff/.openclaw/agents/main/agent/auth-profiles.json'` — current auth
- `ssh gateway 'docker exec openclaw-upstream env | sort'` — current env vars
- `ssh gateway 'docker logs openclaw-upstream --tail 20 2>&1'` — current state

If you skip this reading, you WILL break things. Every breakage in this deployment
has been caused by an agent guessing instead of reading.

## CRITICAL: OpenAI Auth Policy

**ALL LLM traffic (chat, completions, responses) uses OpenAI OAuth exclusively.**
Jeff has OpenAI Pro ($200/month) and Claude Max ($200/month) subscriptions with generous token allowances.

### Rules (non-negotiable)

1. **NEVER set `OPENAI_API_KEY` as an environment variable.** Not in Docker, not in Ansible, not in env files, not anywhere.
2. **NEVER use an API key for chat/completions/responses.** The OAuth token from `openai-codex` provider handles all LLM traffic.
3. **The ONLY API key that exists is `OPENAI_EMBEDDINGS_API_KEY`** and it is used EXCLUSIVELY by the `memory-lancedb` plugin for `text-embedding-3-small` embeddings.
4. **If you see `OPENAI_API_KEY` anywhere in config, env, or code — it is WRONG.** Remove it and use `OPENAI_EMBEDDINGS_API_KEY` if embeddings are needed, or OAuth for everything else.
5. **Auth profiles must use `mode: "oauth"` with provider `openai-codex`.** Never `mode: "api_key"`.

### Environment Variables

| Variable | Purpose | Used By |
|---|---|---|
| `OPENAI_EMBEDDINGS_API_KEY` | text-embedding-3-small ONLY | memory-lancedb plugin |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth | Gateway |
| `TELEGRAM_BOT_TOKEN` | Telegram channel | Telegram plugin |

There is NO `OPENAI_API_KEY` variable. If an agent or script tries to add one, it is wrong.

### Why This Matters

Using an API key for LLM traffic when OAuth is available means paying per-token on top of a $200/month subscription. This has been a recurring problem caused by agents defaulting to API key auth. Stop doing it.

## CRITICAL: Gateway Config Editing Rules

### The One Rule That Prevents All Config Breakage

**READ FIRST, THEN EDIT. Never assume. Never write from scratch. Never guess values.**

There is always an existing working config, an existing auth-profiles.json, an existing fork setup, or an existing running container to read from. Use it. If you find yourself typing a config value from memory or assumption instead of copying it from an actual source file, STOP — you are about to break something.

### Process (non-negotiable)

1. **Before ANY config change:** Read the current file. Read auth-profiles.json. Read the running container's env. Read the old fork's config if migrating. Use `cat` and `docker exec` to get FACTS.
2. **Make surgical edits only.** To add a plugin: read the file, add ONE key, write it back. Do not rewrite sibling keys. Do not "clean up" unrelated fields.
3. **After ANY config change:** `docker restart openclaw-upstream && sleep 10 && docker logs openclaw-upstream --since 15s 2>&1 | grep -i "error\|fail\|credential\|No API key"` — if there are errors, you broke it. Fix it before moving on.
4. **Never change auth, model, or channel config** unless explicitly asked. These are working — leave them alone.
5. **When migrating from the fork:** The fork's actual config files are the spec. Read them. Copy values. Do not reinterpret or "improve" them.

### Container Persistence Rules

The Docker container uses an ephemeral filesystem. Only `/home/node/.openclaw` is persistent (volume-mounted from host). Anything installed or configured outside this path is lost on restart.

**What survives restarts (volume-mounted):**
- `/home/node/.openclaw/openclaw.json` — gateway config
- `/home/node/.openclaw/agents/` — auth-profiles, agent state
- `/home/node/.openclaw/.ssh/` — SSH keys + config (symlinked to `~/.ssh` at startup)
- `/home/node/.openclaw/config/` — fleet.json
- `/home/node/.openclaw/memory/` — LanceDB data

**What does NOT survive restarts:**
- `pip install` packages — must be baked into the Docker image
- `/home/node/.ssh/` — use the `.openclaw/.ssh` symlink pattern instead
- Any files written to `/app/`, `/tmp/`, or other non-volume paths

**Container entrypoint:** `sh -c 'ln -sf /home/node/.openclaw/.ssh /home/node/.ssh && exec node dist/index.js gateway run --bind lan --port 18789 --force'`

This symlink is critical — without it, SSH keys are invisible to the gateway and all fleet SSH operations fail.

### Current Canonical Config State

- Auth profile key: `openai-codex:default`
- Auth provider: `openai-codex`
- Auth mode: `oauth`
- Model: `openai-codex/gpt-5.4-mini`
- Plugins: `memory-lancedb`, `fleet-coordinator`, `telegram-agentic`, `telegram`
- Memory slot: `memory-lancedb`
- Channels: `telegram` (enabled, allowlist, no mention required)
