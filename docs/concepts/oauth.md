---
summary: "OAuth in OpenClaw: token exchange, storage, and multi-account patterns"
read_when:
  - You want to understand OpenClaw OAuth end-to-end
  - You hit token invalidation / logout issues
  - You want Claude CLI or OAuth auth flows
  - You want multiple accounts or profile routing
title: "OAuth"
---

# OAuth

OpenClaw supports “subscription auth” via OAuth for providers that offer it
(notably **OpenAI Codex (ChatGPT OAuth)**). For Anthropic subscriptions, new
setup should use the local **Claude CLI** login path on the gateway host, but
Anthropic changed third-party harness billing on
**April 4, 2026 at 12:00 PM PT / 8:00 PM BST**: Anthropic says Claude
subscription limits no longer cover OpenClaw and Anthropic now requires **Extra
Usage** for that traffic. OpenAI Codex OAuth is explicitly supported for use in
external tools like OpenClaw. This page explains:

For Anthropic in production, API key auth is the safer recommended path.

- how the OAuth **token exchange** works (PKCE)
- where tokens are **stored** (and why)
- how to handle **multiple accounts** (profiles + per-session overrides)

OpenClaw also supports **provider plugins** that ship their own OAuth or API‑key
flows. Run them via:

```bash
openclaw models auth login --provider <id>
```

## The token sink (why it exists)

OAuth providers commonly mint a **new refresh token** during login/refresh flows. Some providers (or OAuth clients) can invalidate older refresh tokens when a new one is issued for the same user/app.

Practical symptom:

- you log in via OpenClaw _and_ via Claude Code / Codex CLI → one of them randomly gets “logged out” later

To reduce that, OpenClaw treats `auth-profiles.json` as a **token sink**:

- the runtime reads credentials from **one place**
- we can keep multiple profiles and route them deterministically
- when credentials are reused from an external CLI like Codex CLI, OpenClaw
  mirrors them with provenance and re-reads that external source instead of
  rotating the refresh token itself

## Storage (where tokens live)

Secrets are stored **per-agent**:

- Auth profiles (OAuth + API keys + optional value-level refs): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Legacy compatibility file: `~/.openclaw/agents/<agentId>/agent/auth.json`
  (static `api_key` entries are scrubbed when discovered)

Legacy import-only file (still supported, but not the main store):

- `~/.openclaw/credentials/oauth.json` (imported into `auth-profiles.json` on first use)

All of the above also respect `$OPENCLAW_STATE_DIR` (state dir override). Full reference: [/gateway/configuration](/gateway/configuration-reference#auth-storage)

For static secret refs and runtime snapshot activation behavior, see [Secrets Management](/gateway/secrets).

## Anthropic OAuth/token compatibility

<Warning>
Anthropic changed third-party harness billing on **April 4, 2026 at 12:00 PM
PT / 8:00 PM BST**. Anthropic says Claude subscription limits no longer cover
OpenClaw or other third-party harnesses. Existing Anthropic OAuth/token profiles
remain technically usable in OpenClaw, but Anthropic now requires **Extra
Usage** (pay-as-you-go billed separately from the subscription) for that
traffic.

If you want other subscription-style options in OpenClaw, see [OpenAI
Codex](/providers/openai), [Qwen Cloud Coding
Plan](/providers/qwen), [MiniMax Coding Plan](/providers/minimax),
and [Z.AI / GLM Coding Plan](/providers/glm).
</Warning>

OpenClaw no longer offers Anthropic setup-token onboarding or auth commands for
new setup. Existing Anthropic OAuth/token profiles are still honored at runtime
if they are already configured.

The generic token helpers still exist for other providers:
`openclaw models auth setup-token --provider <id>` and
`openclaw models auth paste-token --provider <id>`.

## Anthropic Claude CLI migration

If Claude CLI is already installed and signed in on the gateway host, you can
switch Anthropic model selection over to the local CLI backend. This is a
supported OpenClaw path when you want to reuse a local Claude CLI login on the
same host.

Prerequisites:

- the `claude` binary is installed on the gateway host
- Claude CLI is already authenticated there via `claude auth login`

Migration command:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
```

Onboarding shortcut:

```bash
openclaw onboard --auth-choice anthropic-cli
```

This keeps existing Anthropic auth profiles for rollback, but rewrites the main
default-model path from `anthropic/...` to `claude-cli/...`, rewrites matching
Anthropic Claude fallbacks, and adds matching `claude-cli/...` allowlist
entries under `agents.defaults.models`.

Verify:

```bash
openclaw models status
```

## OAuth exchange (how login works)

OpenClaw’s interactive login flows are implemented in `@mariozechner/pi-ai` and wired into the wizards/commands.

### Anthropic Claude CLI

Flow shape:

Claude CLI path:

1. sign in with `claude auth login` on the gateway host
2. run `openclaw models auth login --provider anthropic --method cli --set-default`
3. store no new auth profile; switch model selection to `claude-cli/...`
4. keep existing Anthropic auth profiles for rollback

Interactive assistant path:

- `openclaw onboard` / `openclaw configure` → auth choice `anthropic-cli`

### OpenAI Codex (ChatGPT OAuth)

OpenAI Codex OAuth is explicitly supported for use outside the Codex CLI, including OpenClaw workflows.

Flow shape (PKCE):

1. generate PKCE verifier/challenge + random `state`
2. open `https://auth.openai.com/oauth/authorize?...`
3. try to capture callback on `http://127.0.0.1:1455/auth/callback`
4. if callback can’t bind (or you’re remote/headless), paste the redirect URL/code
5. exchange at `https://auth.openai.com/oauth/token`
6. extract `accountId` from the access token and store `{ access, refresh, expires, accountId }`

Wizard path is `openclaw onboard` → auth choice `openai-codex`.

## Refresh + expiry

Profiles store an `expires` timestamp.

At runtime:

- if `expires` is in the future → use the stored access token
- if expired → refresh (under a file lock) and overwrite the stored credentials
- exception: reused external CLI credentials stay externally managed; OpenClaw
  re-reads the CLI auth store and never spends the copied refresh token itself

The refresh flow is automatic; you generally don't need to manage tokens manually.

## Multiple accounts (profiles) + routing

Two patterns:

### 1) Preferred: separate agents

If you want “personal” and “work” to never interact, use isolated agents (separate sessions + credentials + workspace):

```bash
openclaw agents add work
openclaw agents add personal
```

Then configure auth per-agent (wizard) and route chats to the right agent.

### 2) Advanced: multiple profiles in one agent

`auth-profiles.json` supports multiple profile IDs for the same provider.

Pick which profile is used:

- globally via config ordering (`auth.order`)
- per-session via `/model ...@<profileId>`

Example (session override):

- `/model Opus@anthropic:work`

How to see what profile IDs exist:

- `openclaw channels list --json` (shows `auth[]`)

Related docs:

- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown rules)
- [/tools/slash-commands](/tools/slash-commands) (command surface)

## Related

- [Authentication](/gateway/authentication) — model provider auth overview
- [Secrets](/gateway/secrets) — credential storage and SecretRef
- [Configuration Reference](/gateway/configuration-reference#auth-storage) — auth config keys
