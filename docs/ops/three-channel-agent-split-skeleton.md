# 3-Channel Agent Split (Draft Skeleton)

This draft keeps your channel names exactly:

- `#engineering`
- `#meeting-prep`
- `#blockchain-research`

It also enforces your constraints:

- No Anthropic dependency in defaults/fallbacks (you said Anthropic models are not available).
- Gemini context windows: **no manual override** initially (use provider defaults).
- No hard model lock: do **not** set `agents.defaults.models` allowlist.
- Per-message model override remains available via `/model`.

## Recommended `~/.openclaw/openclaw.json` skeleton (JSON5)

```json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: {
        primary: "google/gemini-3-flash-preview",
      },
      // Intentionally omit `models` allowlist to avoid hard-locking model choices.
    },

    list: [
      {
        id: "eng",
        default: true,
        name: "Engineering",
        workspace: "~/.openclaw/workspace-engineering",
        agentDir: "~/.openclaw/agents/eng/agent",
        model: {
          // Fast default for day-to-day engineering.
          primary: "google/gemini-3-flash-preview",
          // No Anthropic here; Codex used as deeper coding fallback.
          fallbacks: ["openai-codex/gpt-5.2-codex", "google/gemini-3-pro-preview"],
        },
      },
      {
        id: "meetings",
        name: "Meeting Prep",
        workspace: "~/.openclaw/workspace-meeting-prep",
        agentDir: "~/.openclaw/agents/meetings/agent",
        model: {
          // Document-heavy synthesis default.
          primary: "google/gemini-3-pro-preview",
          fallbacks: ["google/gemini-3-flash-preview", "openai-codex/gpt-5.2-codex"],
        },
      },
      {
        id: "chain",
        name: "Blockchain Research",
        workspace: "~/.openclaw/workspace-blockchain-research",
        agentDir: "~/.openclaw/agents/chain/agent",
        model: {
          // Codex backbone for technical reasoning.
          primary: "openai-codex/gpt-5.2-codex",
          fallbacks: ["google/gemini-3-flash-preview", "google/gemini-3-pro-preview"],
        },
      },
    ],
  },

  // Route by exact Discord channel IDs. Keep the same channel names in comments.
  // Replace these placeholders with real channel IDs.
  bindings: [
    {
      agentId: "eng",
      match: {
        channel: "discord",
        guildId: "DISCORD_GUILD_ID",
        peer: { kind: "channel", id: "DISCORD_CHANNEL_ID_ENGINEERING" },
      }, // #engineering
    },
    {
      agentId: "meetings",
      match: {
        channel: "discord",
        guildId: "DISCORD_GUILD_ID",
        peer: { kind: "channel", id: "DISCORD_CHANNEL_ID_MEETING_PREP" },
      }, // #meeting-prep
    },
    {
      agentId: "chain",
      match: {
        channel: "discord",
        guildId: "DISCORD_GUILD_ID",
        peer: { kind: "channel", id: "DISCORD_CHANNEL_ID_BLOCKCHAIN_RESEARCH" },
      }, // #blockchain-research
    },
    {
      agentId: "eng",
      match: {
        channel: "discord",
        guildId: "DISCORD_GUILD_ID",
      }, // guild-wide catch-all for new channels in this guild
    },
  ],

  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          baseUrl: "https://api.perplexity.ai",
          // Balanced default; can be overridden per query intent.
          model: "sonar",
        },
      },
    },
  },

  channels: {
    discord: {
      // Keep explicit and predictable; adjust to your guild policy.
      groupPolicy: "allowlist",
      // Keep command support available so `/model` overrides work in-channel.
      commands: { native: "auto" },
      guilds: {
        "DISCORD_GUILD_ID": {
          requireMention: true,
          users: ["DISCORD_USER_ID_OWNER"],
          channels: {
            "DISCORD_CHANNEL_ID_ENGINEERING": { allow: true },
            "DISCORD_CHANNEL_ID_MEETING_PREP": { allow: true },
            "DISCORD_CHANNEL_ID_BLOCKCHAIN_RESEARCH": { allow: true },
          },
        },
      },
    },
  },
}
```

## Context-window recommendation (applied)

- `eng` on Gemini Flash: use provider-reported default context, no manual override.
- `meetings` on Gemini Pro: use provider-reported default context, no manual override.
- Start with chunk/summarize workflow when payloads get very large; only tune context metadata if logs show truncation.
- If provider context limits change (for example newer 1M-context releases), this plan still holds because we are not hardcoding context metadata.

## Perplexity usage policy by need

Use this policy in prompts/agent instructions:

- Quick fact checks → `perplexity/sonar`
- Standard research synthesis → `sonar` (default)
- Deep chain analysis / competing claims / legal-reg update scans → `sonar-pro` or `sonar-reasoning-pro` (if supported by your account)

`"${PERPLEXITY_API_KEY}"` interpolation is supported by OpenClaw config, but for this deployment we recommend **not** hard-referencing it in `openclaw.json`.

Reason:

- Host-side CLI commands (for example `openclaw agents list`) can fail with `MissingEnvVarError` if the shell environment does not define `PERPLEXITY_API_KEY`, even when the gateway container has the key via Docker secrets.
- Keep `tools.web.search.perplexity` with `baseUrl` + `model` only, and provide `PERPLEXITY_API_KEY` through runtime env/secrets.

## No-hard-lock / override behavior (explicit)

- Do not define `agents.defaults.models` allowlist unless you truly need strict governance.
- Keep `/model` available in all three channels so users can switch model ad-hoc per message.
- Since Anthropic isn’t available now, escalation targets are currently Gemini Pro and Codex.
- If Anthropic is added later, you can escalate in-channel to Sonnet/Opus without changing channel bindings.

## Validation checklist

1. `openclaw agents list --bindings` shows all three bindings.
2. Post a probe in each channel; confirm it routes to `eng` / `meetings` / `chain`.
3. In each channel run `/model status`; verify default model.
4. In `#engineering`, run `/model openai-codex/gpt-5.2-codex` for one task, then switch back to Flash.
5. In `#blockchain-research`, run one query for each search depth class (sonar / sonar-pro / sonar-reasoning-pro) and verify source-backed output.
6. Verify guild allowlist works: message from a non-allowlisted user is ignored.
7. Create a 4th test channel in the same guild and confirm it routes to `eng` via the guild catch-all binding.
8. Verify `agentDir` paths exist and contain `AGENTS.md` before first message.
9. Run `openclaw agents list --bindings` on host shell; confirm config parses without `MissingEnvVarError`.

## Execution plan (ready to run)

### Phase 0 — Collect IDs and prep files

1. Collect these values from Discord:
  - `DISCORD_GUILD_ID`
  - `DISCORD_CHANNEL_ID_ENGINEERING`
  - `DISCORD_CHANNEL_ID_MEETING_PREP`
  - `DISCORD_CHANNEL_ID_BLOCKCHAIN_RESEARCH`
  - `DISCORD_USER_ID_OWNER`
2. Ensure each agentDir exists and has seed instructions:

```bash
mkdir -p ~/.openclaw/agents/eng/agent ~/.openclaw/agents/meetings/agent ~/.openclaw/agents/chain/agent
test -f ~/.openclaw/agents/eng/agent/AGENTS.md || printf '# Engineering agent\n' > ~/.openclaw/agents/eng/agent/AGENTS.md
test -f ~/.openclaw/agents/meetings/agent/AGENTS.md || printf '# Meeting prep agent\n' > ~/.openclaw/agents/meetings/agent/AGENTS.md
test -f ~/.openclaw/agents/chain/agent/AGENTS.md || printf '# Blockchain research agent\n' > ~/.openclaw/agents/chain/agent/AGENTS.md
```

### Phase 1 — Apply config safely

1. Backup current config:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
```

2. Paste/update the JSON5 skeleton in `~/.openclaw/openclaw.json` and replace all placeholders.
3. Confirm `PERPLEXITY_API_KEY` resolves in runtime env (or in config `env` block).
4. Do not set `tools.web.search.perplexity.apiKey` in `openclaw.json` unless you are sure every host shell/daemon env that runs `openclaw` exports it.

### Phase 2 — Reload gateway and confirm routing

1. Restart/recreate your running gateway service.
2. Confirm service healthy and bindings loaded:

```bash
openclaw agents list --bindings
```

3. Verify model defaults per channel with `/model status` from each Discord channel:
  - `#engineering` -> Gemini Flash
  - `#meeting-prep` -> Gemini Pro
  - `#blockchain-research` -> Codex

### Phase 3 — Functional validation

Run this exact sequence:

1. Post a probe message in each of the three channels and confirm agent mapping.
2. In `#engineering`, run `/model openai-codex/gpt-5.2-codex` for one task, then switch back.
3. In `#blockchain-research`, run 3 searches with policy depth:
  - fact check (`perplexity/sonar`)
  - synthesis (`sonar`)
  - deep research (`sonar-pro` or `sonar-reasoning-pro`)
4. Send message from a non-allowlisted user and confirm no response.
5. Create a temporary 4th channel in the same guild and confirm it routes to `eng`.

### Phase 4 — Rollback path (if any check fails)

```bash
cp ~/.openclaw/openclaw.json.bak.<timestamp> ~/.openclaw/openclaw.json
# restart gateway service after restore
```

Rollback triggers:

- Wrong agent routing in any of the three production channels.
- `/model` override fails in-channel.
- Non-allowlisted users can trigger replies.
- Perplexity search unavailable in blockchain workflow.
- Host CLI commands fail with config `MissingEnvVarError`.

## Troubleshooting quick reference

- `Missing env var "PERPLEXITY_API_KEY" referenced at config path ...`:
  - Remove `tools.web.search.perplexity.apiKey` from `openclaw.json`, or export the var in the shell/service environment before running `openclaw` commands.
- `Perplexity API error (400): Invalid model ...`:
  - Set `tools.web.search.perplexity.model` to `sonar`, restart gateway, and re-test.
- Agent routing appears wrong after update:
  - Re-run `openclaw agents list --bindings` and verify the 4 binding rules (3 channel-specific + 1 guild catch-all).
- Overrides fail in channel:
  - Confirm `/model status` works and ensure no `agents.defaults.models` allowlist was reintroduced.

## Ready-to-execute definition

You are ready to execute once all are true:

- Placeholders replaced with real Discord IDs.
- `agentDir` directories exist with `AGENTS.md` files.
- `PERPLEXITY_API_KEY` available to gateway runtime.
- Backup file created for immediate rollback.
