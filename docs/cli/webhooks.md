---
summary: "CLI reference for `openclaw webhooks` (webhook helpers + Gmail Pub/Sub + IMAP)"
read_when:
  - You want to wire Gmail Pub/Sub events into OpenClaw
  - You want to wire IMAP email events into OpenClaw
  - You want webhook helper commands
title: "webhooks"
---

# `openclaw webhooks`

Webhook helpers and integrations (Gmail Pub/Sub, IMAP, webhook helpers).

Related:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)
- IMAP Hooks: [IMAP Hooks](/automation/imap)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

See [Gmail Pub/Sub documentation](/automation/gmail-pubsub) for details.

## IMAP

```bash
openclaw webhooks imap setup --account my-email-account --allowed-senders owner@example.com
openclaw webhooks imap run
```

See [IMAP Hooks documentation](/automation/imap) for details.

## Command Reference

**Gmail commands:**

- `openclaw webhooks gmail setup` - Configure Gmail watch + Pub/Sub + OpenClaw hooks
- `openclaw webhooks gmail run` - Run gog watch serve + auto-renew loop

**IMAP commands:**

- `openclaw webhooks imap setup` - Configure IMAP watcher + OpenClaw hooks
- `openclaw webhooks imap run` - Run IMAP poll watcher loop
