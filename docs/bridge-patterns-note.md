# Research Note: WhatsApp/Telegram Bridge + Batch Moderation Patterns

## Public patterns worth reusing
- Webhook ingestion + queue + worker is the dominant pattern in Bot API examples (Telegram bots, WhatsApp Cloud API integrations, open-source relay bots).
- Human-in-the-loop moderation commonly uses a pending queue with numbered approvals (`send 1`, `skip 2`) instead of immediate forwarding.
- Idempotency keys on inbound messages are standard to avoid duplicate replies on retries/webhook redelivery.
- Dry-run or shadow mode is common in ops-heavy bots to validate command parsing before enabling sends.
- Local JSON state works well for single-operator workflows; teams usually move to SQLite/Postgres once concurrency and audit requirements grow.

## Tooling categories seen in practice
- Telegram side: Bot API wrappers (`node-telegram-bot-api`, `telegraf`) and simple command parsers.
- WhatsApp side: Meta WhatsApp Cloud API (official) or gateway wrappers; some teams use Twilio for managed webhook + sender abstraction.
- Orchestration: cron-triggered digest jobs, queue workers, and message templates stored in DB or files.

## 80/20 we can reuse immediately
- Keep current queue + digest + explicit approval command model.
- Keep dry-run as default operator habit for risky batch commands.
- Keep deterministic command grammar (`send`, `rewrite`, `skip`) because it is easy to parse and audit.
- Add contacts map for operator ergonomics so name lookup is constant-time and scriptable.

## What still needs custom logic
- Runtime send guard enforcement tied to your exact security model (already in progress elsewhere).
- Voice/tone drafting logic and ranking of draft options.
- Policy rules for urgent bypass/VIP escalation.
- Channel-specific formatting/normalization details and future analytics.

## Gaps to watch
- JSON file storage is single-writer friendly but fragile under concurrent writers.
- No immutable audit log yet for who approved what and when.
- Contact aliases and normalization (e.g., punctuation, duplicate names) may need tighter rules as contact count grows.
