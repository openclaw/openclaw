# Batch Reply Runbook

## Files and scripts
- Queue file: `memory/reply-queue.json`
- Contacts map: `memory/contacts.json`
- Queue CLI: `node scripts/reply-queue.mjs`
- Approval dispatcher: `node scripts/dispatch-approved-replies.mjs`
- Contacts CLI: `node scripts/contacts-map.mjs`

## Queue operations
Add one inbound WhatsApp message with drafts:
```bash
cat <<'JSON' | node scripts/reply-queue.mjs add-json
{
  "channel": "whatsapp",
  "from": "+971000000000",
  "text": "their latest message",
  "drafts": [
    "draft option a",
    "draft option b"
  ]
}
JSON
```

List pending:
```bash
node scripts/reply-queue.mjs list --json
```

Render digest:
```bash
node scripts/reply-queue.mjs digest --limit 20
```

## Digest trigger
Digest should run when either condition is true:
- Heartbeat/system event includes `BATCH_DIGEST_RUN`
- Operator explicitly asks for digest/pending queue

Manual digest command:
```bash
node scripts/reply-queue.mjs digest --limit 20
```

## Approvals
Dry run first:
```bash
node scripts/dispatch-approved-replies.mjs --command "send 1 and rewrite 2: <exact text>" --dry-run
```

Execute for real:
```bash
node scripts/dispatch-approved-replies.mjs --command "send 1 and rewrite 2: <exact text>"
```

More examples:
```bash
node scripts/dispatch-approved-replies.mjs --command "send 1,3" --dry-run
node scripts/dispatch-approved-replies.mjs --command "skip 4" --dry-run
node scripts/dispatch-approved-replies.mjs --command "rewrite 2: Tightened reply copy" --dry-run
```

## Contacts map (`text <name>`)
Add/update contact:
```bash
node scripts/contacts-map.mjs upsert --name "Alice" --target "+15551234567"
```

Resolve by name:
```bash
node scripts/contacts-map.mjs resolve --name "Alice"
```

`text <name>` resolution path:
```bash
node scripts/contacts-map.mjs text Alice --json
```

If not found, script returns a clear not-found result and a suggested add command.

## Optional explicit file paths
If needed, pin file paths with env vars:
```bash
OPENCLAW_REPLY_QUEUE=/absolute/path/reply-queue.json node scripts/reply-queue.mjs list --json
OPENCLAW_CONTACTS_MAP=/absolute/path/contacts.json node scripts/contacts-map.mjs list --json
```
