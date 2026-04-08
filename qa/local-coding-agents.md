# Local Coding Agents

This repo can bootstrap a small local OpenClaw coding setup for development and QA.

The goal is narrow:

- create stable local agent profiles for repo work
- make those profiles reproducible instead of ad hoc
- provide a single selftest entrypoint for the core local coding paths

## Files

- `scripts/dev/bootstrap-local-coding-agents.mjs`
  - upserts local coding agent profiles into `~/.openclaw/openclaw.json`
  - updates `tools.agentToAgent.allow`
  - extends `main.subagents.allowAgents`
  - writes a timestamped backup of the original config
- `scripts/dev/local-coding-agents-selftest.sh`
  - validates `exec`, `read`, `patch`, and optional GitHub/WhatsApp live checks

## Agent Profiles

The bootstrap creates:

- `oc-builder`
  - workspace: this repo
  - purpose: local code execution, repo reads, patching
- `oc-github`
  - workspace: this repo
  - purpose: `gh`-based repository work

Default model:

- `openai-codex/gpt-5.3-codex-spark`

Override it when needed:

```bash
OPENCLAW_LOCAL_AGENT_MODEL=google-gemini/gemini-2.0-flash \
pnpm qa:local-agents:bootstrap
```

## Commands

Bootstrap the local coding profiles:

```bash
pnpm qa:local-agents:bootstrap
```

Run the end-to-end selftest:

```bash
PATH="${OPENCLAW_SELFTEST_NODE_BIN:-$HOME/.node22/current/bin}:$PATH" \
pnpm qa:local-agents:selftest
```

The explicit `PATH` export is only needed when your shell resolves `openclaw`
through an older Node runtime than the installed CLI accepts.

## What the Selftest Verifies

Always:

- `exec` through `oc-builder`
- repo file reads through `oc-builder`
- repo patching through `oc-builder`

When available:

- GitHub CLI access through `oc-github`
- live WhatsApp self-delivery through `main`

By default, GitHub and WhatsApp are skipped when the local environment is not
ready for them. Make them hard requirements with:

```bash
OPENCLAW_SELFTEST_REQUIRE_GITHUB=1 \
OPENCLAW_SELFTEST_REQUIRE_WHATSAPP=1 \
pnpm qa:local-agents:selftest
```

## Real Task Examples

Read repo data through the builder agent:

```bash
PATH="${OPENCLAW_SELFTEST_NODE_BIN:-$HOME/.node22/current/bin}:$PATH" \
openclaw agent --agent oc-builder \
  --message "Nutze read, lies package.json und antworte mit dem lokalen Agent-Selftest-Scriptnamen." \
  --json
```

Run GitHub repo inspection:

```bash
PATH="${OPENCLAW_SELFTEST_NODE_BIN:-$HOME/.node22/current/bin}:$PATH" \
openclaw agent --agent oc-github \
  --message "Nutze exec und führe 'gh repo view --json nameWithOwner,isFork,url' aus." \
  --json
```

## Expected Local Side Effects

Bootstrap writes only to local OpenClaw state:

- `~/.openclaw/openclaw.json`
- `~/.openclaw/openclaw.json.bak.local-coding-agents-*`

The scripts do not publish or push anything. Live checks only touch the services
you explicitly have available in the local environment.
