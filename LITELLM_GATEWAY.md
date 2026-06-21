# LiteLLM provider gateway for OpenClaw

Fallback safety-net so OpenClaw never stalls when the Claude (subscription)
runtime runs out of tokens / hits a rate limit / needs Max-Pro.

## Architecture

```
Telegram
  ↓
OpenClaw gateway (openclaw-gateway.service)
  ↓  primary: claude-cli / codex SUBSCRIPTION runtimes (unchanged, free)
  ↓  fallback: litellm/openclaw-auto
LiteLLM (127.0.0.1:4000)
  ↓  1) OpenRouter  anthropic/claude-sonnet-4-6   (Claude tier)
  ↓  2) Ollama      qwen3:8b
  ↓  3) Ollama      qwen2.5:3b  (lightweight last resort)
```

OpenClaw keeps Claude via the `claude-cli` subscription as primary (free).
LiteLLM is an HTTP gateway and cannot proxy that subscription, so it sits as a
**fallback tier**. When the subscription fails, OpenClaw falls through to
`litellm/openclaw-auto`, which itself fans out OpenRouter → Ollama.

`ANTHROPIC_API_KEY` is **optional**. The Claude tier is served by OpenRouter
(key already owned). To make direct Anthropic the top tier, set
`ANTHROPIC_API_KEY` in `.env` and prepend `claude-primary` to the
`openclaw-auto` fallback list in `litellm.config.yaml`.

## Files

- `docker-compose.litellm.yml` — standalone compose (does not touch the main one)
- `litellm.config.yaml` — model list + fallback chains
- `.env.example` — required/optional env keys (copy to `.env`, fill, never commit)
- `litellm-test.sh` — healthcheck + smoke + fallback drill

## Run

```bash
cp .env.example .env        # then fill OPENROUTER_API_KEY + LITELLM_MASTER_KEY
docker compose -f docker-compose.litellm.yml up -d
./litellm-test.sh
```

## Healthcheck + manual tests

```bash
curl http://127.0.0.1:4000/health/liveliness                 # "I'm alive!"
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw-auto","messages":[{"role":"user","content":"Ответь одним словом: OK"}]}'
```

## OpenClaw wiring (live config)

`~/.openclaw/openclaw.json` gets a `litellm` provider
(`api: openai-completions`, `baseUrl: http://127.0.0.1:4000/v1`, model
`openclaw-auto`) and `litellm/openclaw-auto` appended as a fallback on the
Claude-only agents: `claude-dev`, `claude-smart`, `trust`, `legal`, `analyst`.
`architect` already had its own chain and is left untouched.

Changes take effect on the next gateway restart:

```bash
systemctl --user restart openclaw-gateway.service
```

## Health monitor (alert + auto-restart)

A systemd `--user` timer checks `/health/liveliness` every 2 minutes. If the
gateway is down it attempts an idempotent `docker compose up -d`, rechecks, and
alerts the owner over the existing Telegram bot via `openclaw message send` (no
new token, no polling conflict). Alerts fire only on transitions (up↔down), so
no spam.

Files:

- `litellm-health-monitor.sh` — the check + restart + alert logic
- `deploy/systemd/litellm-health-monitor.{service,timer}` — installed copies live
  in `~/.config/systemd/user/`

Install / control:

```bash
cp deploy/systemd/litellm-health-monitor.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now litellm-health-monitor.timer
systemctl --user list-timers litellm-health-monitor.timer   # next fire
tail -f ~/.openclaw/litellm-monitor.log                     # monitor log
```

State: `~/.openclaw/.litellm-monitor-state` (`up`/`down`). Owner Telegram target
is resolved at runtime (first user peer) — no chat id stored on disk; override
with `MONITOR_TARGET` if needed.

> The monitor auto-restarts the container. To take LiteLLM down for real
> (rollback), **stop the timer first** or it will bring the container back:
> `systemctl --user disable --now litellm-health-monitor.timer`

## Teardown / rollback

```bash
docker compose -f docker-compose.litellm.yml down
# restore live config from the timestamped backup if needed:
#   cp ~/.openclaw/openclaw.json.bak-litellm-<TS> ~/.openclaw/openclaw.json
# LiteLLM merged to main (commit 1ca59c3e) — no feature branch to delete
```
