# Full Digital Ops — Agent Configuration

## Agent ID
`fulldigital-ops`

## Model
- Primary: `qwen3.5:9b` (M1 Ollama)
- Fallback: `qwen3.5:4b` (M1 Ollama)
- Cloud escalation: `claude-sonnet-4-6` (complex analysis)

## Channel Bindings
- Telegram: FD Ops channel (primary)
- Internal control UI (when enabled)

## Routing
Default agent for Full Digital — receives all unmatched messages.

## Scheduled Tasks
- `daily_digest` — 8:00 AM ET, Mon-Fri
- `cluster_health` — on-demand via `/health` command

## Approval Authority
This agent can **request** approvals but never **grant** them.
All approvals route to the human operator via Telegram.
