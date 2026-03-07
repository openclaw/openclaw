# Platinum Fang Whitepaper Q&A

Version: 1.0  
Audience: Operator/Owner  
Scope: Local-first, high-security Platinum Fang deployment profile branded as **Platinum Fang**

---

## 0) Read first capability by switch matrix

Read this section before boot. It defines what each high-impact switch controls and how the bot reacts.

| Switch / key | Recommended safe value | More permissive values | Bot reaction when enabled | Bot reaction when disabled | Verify command |
|---|---|---|---|---|---|
| `gateway.mode` | `local` | `cloud` (deployment-specific) | Gateway accepts local runtime profile and normal operations | Gateway can block startup when unset/mismatched | `openclaw config get gateway.mode` |
| `gateway.bind` | `loopback` | `lan` | Control UI and gateway bind to local host only | Broader network reachability/risk if exposed | `openclaw config get gateway.bind` |
| `channels.discord.enabled` | `true` for remote control; `false` for local-only work profiles | `false` / `true` | Bot can receive/send Discord traffic | No Discord interaction surface | `openclaw config get channels.discord.enabled` |
| `channels.discord.dmPolicy` | `pairing` | `open` | Unknown DM senders must pair first | Unknown senders can interact immediately | `openclaw config get channels.discord.dmPolicy` |
| `channels.discord.groupPolicy` | `allowlist` | `open` | Only explicitly allowed guild contexts can trigger bot | Any configured guild/group can trigger bot | `openclaw config get channels.discord.groupPolicy` |
| `channels.discord.guilds.<id>.requireMention` | `true` | `false` | Bot responds only when explicitly mentioned in guild | Bot may respond to non-mentioned traffic in allowed channels | `openclaw config get channels.discord.guilds` |
| `channels.discord.guilds.<id>.users[]` | explicit owner/trusted IDs | broader lists | Only listed users can trigger in guarded guild mode | Expanded trigger population | `openclaw config get channels.discord.guilds` |
| `tools.profile` | `messaging` (safe) / `coding` (dev sessions) | `full` | Tool envelope follows profile guardrails | Fewer or narrower tool actions available | `openclaw config get tools.profile` |
| `tools.deny` | include `gateway,cron,sessions_spawn,sessions_send` (+ optional `group:runtime,group:fs,group:web,browser`) | fewer denies | Blocked groups/actions fail closed | More actions become available | `openclaw config get tools.deny` |
| `tools.elevated.enabled` | `false` | `true` | Elevated execution path remains disabled | Elevated actions may be allowed | `openclaw config get tools.elevated.enabled` |
| `tools.fs.workspaceOnly` | `true` | `false` | File actions constrained to workspace | File actions may reach outside workspace | `openclaw config get tools.fs.workspaceOnly` |
| `tools.exec.applyPatch.workspaceOnly` | `true` | `false` | Patch operations constrained to workspace | Patch path scope broadens | `openclaw config get tools.exec.applyPatch.workspaceOnly` |
| `agents.defaults.sandbox.mode` | `all` | `off` / partial modes | Every session runs with sandbox policy | Less isolation and higher execution risk | `openclaw config get agents.defaults.sandbox.mode` |
| `session.dmScope` | `per-channel-peer` | broader scopes | DM context isolated per peer/channel boundary | Wider context carryover across conversations | `openclaw config get session.dmScope` |
| `agents.defaults.model.primary` | trusted production model | experimental model IDs | Primary inference route controls quality/latency/cost | Fallback path used on primary failure | `openclaw config get agents.defaults.model.primary` |
| `agents.defaults.model.fallbacks` | explicit ordered fallback chain | empty or broad chains | Predictable failover behavior | Model failures may stop replies if no fallback | `openclaw config get agents.defaults.model` |
| `OPENROUTER_API_KEY` / provider auth | set and valid | missing/invalid | Provider-backed models respond normally | Provider requests fail auth and replies fail | `openclaw models status` |
| `OPENCLAW_GATEWAY_TOKEN` | set and stable | unset/rotating per command | Stable CLI-to-gateway auth and reduced restarts | Probe/auth instability and command failures | `openclaw gateway status` |

Minimum pre-boot checks:
```bash
scripts/platinumfang-work.sh status
docker compose run --rm openclaw-cli security audit --deep
docker compose run --rm openclaw-cli pairing list discord
```

---

## 1) What is Platinum Fang?

**Q:** What is Platinum Fang?  
**A:** Platinum Fang is a hardened operating profile and runbook focused on:
- local-first runtime
- Discord-first collaboration
- strict security boundaries
- on-demand usage (only when you are working)

Platinum Fang is not a separate codebase. It is a security-first deployment pattern on top of the underlying engine.

---

## 2) Why Platinum Fang uses strict defaults

**Q:** Why is everything locked down by default?  
**A:** Because AI assistants handle untrusted input by default. The secure baseline is:
- explicit identity controls first
- tool restrictions second
- model intelligence third

If your bot is reachable by many users and has broad tools, prompt injection risk grows quickly.

---

## 3) Trust model in plain language

**Q:** Is this multi-tenant secure for adversarial users?  
**A:** No. Platinum Fang uses a personal-assistant trust model and enforces a one-owner boundary unless you explicitly add trusted users.

**Q:** What does that mean operationally?  
**A:** Treat one gateway as one trust boundary. Do not share broad tool authority with untrusted users.

---

## 4) Core architecture

**Q:** What architecture does Platinum Fang use?  
**A:** 
1. Dockerized gateway
2. Loopback bind only
3. Discord channel integration
4. Local model primary (Ollama)
5. Cloud fallback optional (OpenRouter free-first chain)
6. Sandboxing and strict tool policy

**Q:** Why loopback only?  
**A:** It prevents accidental internet exposure. Remote access should use secure tunneling/tailnet patterns.

---

## 5) Your configured Discord identity policy

**Q:** Why do I have 1 user instead of unlimited?  
**A:** Because guild policy is set to one approved user ID:
- Server ID: `1478877509285318656`
- Allowed user ID list includes only: `1143280146435027108`

That is intentional maximum safety.

**Q:** How do I add more users safely?  
**A:** Add specific IDs to the `users` array. Do not open wildcard access unless you accept higher risk.

---

## 6) Mode system (safe/power/off)

**Q:** What does `safe` mode do?  
**A:** 
- strict tools profile
- deny high-risk control-plane/runtime groups
- elevated execution disabled
- Discord mention required in guild
- per-peer DM session isolation
- local-first model chain

**Q:** What does `power` mode do?  
**A:** 
- less restrictive tool profile for trusted focused work
- still keeps key dangerous control-plane paths denied
- mention requirement can be relaxed
- cloud-first fallback possible

**Q:** What does `off` mode do?  
**A:** Stops containers so assistant is inactive when you are not working.

---

## 7) Command reference: how and why

### `scripts/platinumfang-mode.sh safe`
- Sets hardened daily posture.
- Use at start of work.

### `scripts/platinumfang-mode.sh power`
- Enables a more permissive posture.
- Use only when you intentionally need it.

### `scripts/platinumfang-mode.sh status`
- Shows container status and key policy/model settings.
- Use to verify current operational state.

### `scripts/platinumfang-mode.sh off`
- Stops services.
- Use at end of day.

### `scripts/platinumfang-mode.sh mention-on` / `mention-off`
- Controls guild response gating.
- `mention-on` is safer and recommended.

### `scripts/platinumfang-mode.sh discord-on` / `discord-off`
- Enables or disables Discord integration.
- `discord-off` is a quick containment switch.

### `scripts/platinumfang-mode.sh local-only`
- Restricts primary/fallback chain to local model behavior.

### `scripts/platinumfang-mode.sh cloud-only`
- Uses cloud route chain when local model is unavailable or insufficient.

---

## 8) Model strategy

**Q:** Why local-first?  
**A:** Better privacy and cost control.

**Q:** Why keep cloud fallback?  
**A:** Reliability and quality when local hardware/model limits are hit.

**Recommended order**
1. Local primary (Ollama tool-capable model)
2. OpenRouter free GLM path
3. OpenRouter free router path
4. Optional premium GLM fallback

---

## 9) Token and credential security

**Q:** What if a token is exposed?  
**A:** Immediate incident response:
1. Rotate token at provider (Discord Developer Portal -> Bot -> Reset Token)
2. Update local configuration with new token
3. Unset shell env variable
4. Re-run security verification commands

**Q:** Should tokens be committed to files?  
**A:** No. Keep secrets out of versioned docs/scripts. Inject at runtime via environment or secret references.

---

## 10) Daily operator runbook

### Start work
```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-mode.sh safe
```

### Verify
```bash
scripts/platinumfang-mode.sh status
docker compose run --rm openclaw-cli security audit --deep
```

### End work
```bash
cd "/mnt/e/Sterling Storage/openclaw"
scripts/platinumfang-mode.sh off
```

---

## 11) Discord onboarding checklist

1. Create app and bot in Discord Developer Portal
2. Enable Message Content Intent and Server Members Intent
3. Invite bot with required scopes/permissions
4. Set bot token in Platinum Fang config
5. Configure DM pairing + guild allowlist + mention gating
6. DM bot, retrieve pairing code, approve pairing
7. Validate with status and security audit

---

## 12) Troubleshooting Q&A

**Q:** Why did `VAR=value` fail in terminal?  
**A:** That syntax is Bash, not PowerShell. Use WSL/bash for Linux-style commands.

**Q:** Why did `unset` fail?  
**A:** `unset` is Bash-only. In PowerShell use `$env:VAR=$null`; in Bash use `unset VAR`.

**Q:** Why is `docker` not recognized?  
**A:** Docker is not available in that shell context. Use WSL terminal where Docker CLI is configured.

**Q:** Why are responses getting clipped?  
**A:** Terminal UI paging/scroll constraints. Use markdown runbook files and `Get-Content <file> | more`.

---

## 13) Expansion policy (how to scale safely)

**Q:** How to add more users safely?  
**A:** Add user IDs one-by-one in guild allowlist and keep mention gating on.

**Q:** How to open access broadly?  
**A:** Not recommended. If required, do it temporarily and with stricter tool lockdown.

**Q:** How to support multiple trust groups?  
**A:** Separate gateways/hosts per trust boundary.

---

## 14) Platinum Fang control principles

1. Default deny
2. Explicit allowlists
3. Minimal tool exposure
4. Local-first model routing
5. Rotate secrets immediately after exposure
6. Keep runtime off when not in use
7. Verify posture continuously (`security audit --deep`)

---

## 15) Quick command card

```bash
# Start secure
scripts/platinumfang-mode.sh safe

# Current posture
scripts/platinumfang-mode.sh status

# Toggle Discord
scripts/platinumfang-mode.sh discord-off
scripts/platinumfang-mode.sh discord-on

# Mention gating
scripts/platinumfang-mode.sh mention-on
scripts/platinumfang-mode.sh mention-off

# Model routing
scripts/platinumfang-mode.sh local-only
scripts/platinumfang-mode.sh cloud-only

# Stop all
scripts/platinumfang-mode.sh off
```

---

## 16) Coding mode (what you can do and how the bot behaves)

**Q:** What is coding mode for?  
**A:** A trusted local work mode for software development tasks while keeping key control-plane risks blocked.

**Q:** What does coding mode enforce?  
**A:** 
- `tools.profile = coding`
- `channels.discord.enabled = false` (local-only interaction surface)
- `agents.defaults.sandbox.mode = all`
- `tools.fs.workspaceOnly = true`
- `tools.exec.applyPatch.workspaceOnly = true`
- `tools.deny` includes:
  - `gateway`
  - `cron`
  - `sessions_spawn`
  - `sessions_send`

**Q:** How does the bot react in coding mode?  
**A:** 
- It can inspect/edit code and run build/test/lint workflows in the workspace.
- It cannot schedule background jobs (`cron`) or spawn/delegate remote control-plane sessions.
- It cannot act through Discord because Discord is disabled in this mode.
- It stays sandboxed and workspace-scoped for file operations.

**Q:** How do I enter and verify coding mode?  
**A:** 
```bash
scripts/platinumfang-work.sh coding
scripts/platinumfang-work.sh status
```

**Q:** What can I ask it to do in coding mode?  
**A:** 
- "Find top TODO/FIXME hotspots and propose a patch plan."
- "Implement feature X in module Y and run tests."
- "Refactor file Z safely and summarize behavior changes."
- "Run validation checks for modified files and report first actionable failure."

**Q:** What should I do when done coding?  
**A:** Return to hardened inbound posture:
```bash
scripts/platinumfang-mode.sh safe
```

---

## 17) Capability map and control boundary

**Q:** What does "every capability" mean in Platinum Fang context?  
**A:** Every callable Platinum Fang capability that can be safely exposed in a one-owner trust boundary with explicit profile controls and auditability.

**Core domains**
1. Profile and policy switching
2. Channel and identity controls
3. Message operations
4. Agent execution
5. Model/provider routing
6. Security, approvals, sandbox controls
7. Automation triggers and schedules
8. Browser/UI automation
9. Diagnostics, recovery, and handoff

---

## 18) Full profile catalog (switch and reaction)

### `safe`
- Intent: hardened default
- Reaction: strict tools, gated Discord, low blast radius

### `power`
- Intent: temporary trusted expansion
- Reaction: broader tools, still blocks critical delegation paths

### `coding`
- Intent: local software development
- Reaction: workspace edits/tests/refactors, no Discord surface

### `media`
- Intent: local media/editing pipelines
- Reaction: broader local file actions for media workflows

### `social`
- Intent: controlled posting workflows
- Reaction: social/web tasks under tighter runtime/fs group controls

### `freeroam`
- Intent: local on-demand directives
- Reaction: broad local capability while keeping core control-plane denies

### `remote-coding`
- Intent: remote coding via Discord
- Reaction: responds only to allowlisted + mention-gated identity

### `remote-freeroam`
- Intent: remote broad directives
- Reaction: highest remote envelope; use narrow time windows + active oversight

### `off`
- Intent: disable runtime
- Reaction: no task execution

---

## 19) Channel and identity capability chapter

**Discord control posture**
- `dmPolicy=pairing`
- `groupPolicy=allowlist`
- guild `requireMention=true`
- explicit `users` allowlist

**Reaction rules**
- unknown DM sender: pairing flow only
- non-allowlisted guild sender: blocked
- non-mentioned guild message (when mention required): ignored

**Verification**
```bash
docker compose run --rm openclaw-cli config get channels.discord.enabled
docker compose run --rm openclaw-cli config get channels.discord.guilds
docker compose run --rm openclaw-cli pairing list discord
```

---

## 20) Messaging capability chapter

**Capabilities**
- outbound send/read/edit/delete/react/pin flows (provider dependent)
- thread/poll/event/sticker/mod actions where supported

**Reaction model**
- channel disabled/auth invalid/target invalid => fail closed
- valid channel + auth + policy => dispatch action

**Examples**
```bash
openclaw message send --channel discord --target user:<id> --message "status check"
openclaw message poll --channel discord --target channel:<id> --poll-question "Plan?"
```

---

## 21) Agent execution capability chapter

**Capabilities**
- instruction execution
- code/file modifications
- build/test/lint loops
- plan/summarize/report handoff

**Reaction model**
- constrained by active profile (`tools.profile`, `tools.deny`, sandbox, fs scope)
- blocked actions return policy-denied behavior

**Examples**
```bash
openclaw agent --message "Implement feature X and run tests"
openclaw agent --message "Summarize risky diffs and rollback options"
```

---

## 22) Model and provider capability chapter

**Capabilities**
- set primary model + fallbacks
- auth provider tokens/profiles
- failover sequencing

**Reaction model**
- tries primary first, then fallback list
- missing provider auth => model failure

**Examples**
```bash
openclaw config set agents.defaults.model.primary "openrouter/arcee-ai/trinity-large-preview:free"
openclaw config set agents.defaults.model.fallbacks "[\"openrouter/openrouter/free\"]" --strict-json
```

---

## 23) Security, approvals, and sandbox chapter

**Capabilities**
- `security audit --deep`
- sandbox mode controls
- approvals policies and allowlists
- tool denylist governance

**Reaction model**
- hard deny on blocked control-plane/runtime/fs/web groups
- sandbox constraints enforced by session policy
- audit surfaces drift and risk findings

**Examples**
```bash
openclaw security audit --deep
openclaw approvals get
openclaw approvals allowlist add "<command-prefix>"
```

---

## 24) Automation and trigger chapter

**Capabilities**
- cron lifecycle
- hooks/webhooks automation
- heartbeat/system event controls

**Reaction model**
- strict profiles block scheduling/delegation
- permissive profiles can run planned automations

**Examples**
```bash
openclaw cron status
openclaw hooks list
openclaw webhooks list
```

---

## 25) Browser and UI automation chapter

**Capabilities**
- managed browser lifecycle
- navigate/click/type/screenshot/pdf flows
- repeatable UI procedures

**Reaction model**
- blocked when browser/web groups denied
- available in profiles where those groups are allowed

**Examples**
```bash
openclaw browser status
openclaw browser open --url "https://example.com"
openclaw browser screenshot --out shot.png
```

---

## 26) Filesystem and execution boundary chapter

**Controls**
- `tools.fs.workspaceOnly`
- `tools.exec.applyPatch.workspaceOnly`
- `tools.elevated.enabled`

**Reaction model**
- workspace-only flags constrain file and patch operations
- elevated disabled blocks elevated execution path

**Verification**
```bash
openclaw config get tools.fs.workspaceOnly
openclaw config get tools.exec.applyPatch.workspaceOnly
openclaw config get tools.elevated.enabled
```

---

## 27) Diagnostics and recovery chapter

**Capabilities**
- health/status/probe/logs/doctor workflows
- rapid isolation of channel/model/auth/config failures

**Examples**
```bash
openclaw status --all
openclaw health
openclaw logs
openclaw doctor
```

---

## 28) Operator handoff chapter

**When assistant is in control**
1. enforce explicit profile
2. run action
3. verify outcomes
4. return summary + rollback option

**When owner takes control**
1. check active profile
2. check security audit and pairing queue
3. continue planned task chain

**Minimal handoff checks**
```bash
scripts/platinumfang-work.sh status
docker compose run --rm openclaw-cli security audit --deep
docker compose run --rm openclaw-cli pairing list discord
```

---

## 29) Jarvis HUD blueprint chapter

**Required panels**
1. profile switcher with risk badges
2. channel/auth status
3. model primary/fallback + provider auth
4. policy editor with denylist guardrails
5. task queue and results
6. logs/health/audit timeline

**Required control behavior**
- dry-run config diff before apply
- restart-required indicator
- one-click rollback to `safe`
- immutable action history

---

## 30) Final note

Platinum Fang is strongest when used as:
- one owner
- one trust boundary
- strict policies by default
- intentional, auditable temporary expansions

Treat every permission increase as a deliberate change, not a convenience default.
