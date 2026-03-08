---
summary: "IMAP email hooks via himalaya CLI"
read_when:
  - Wiring IMAP inbox triggers to OpenClaw
  - Setting up email polling for agent wake
title: "IMAP Hooks"
---

# IMAP -> OpenClaw

Goal: Poll IMAP inbox -> Process new messages -> OpenClaw webhook.

## Prereqs

- `himalaya` CLI installed and configured ([himalaya](https://github.com/pimalaya/himalaya)).
  Run `himalaya account list` to verify accounts are configured.
- OpenClaw hooks enabled (see [Webhooks](/automation/webhook)).

Example hook config (enable IMAP preset mapping):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["imap"],
    imap: {
      allowedSenders: ["owner@example.com"],
    },
  },
}
```

To deliver the email summary to a chat surface, override the preset with a mapping
that sets `deliver` + optional `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["imap"],
    mappings: [
      {
        match: { path: "imap" },
        action: "agent",
        wakeMode: "now",
        name: "Email",
        sessionKey: "hook:imap:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

If you want a fixed channel, set `channel` + `to`. Otherwise `channel: "last"`
uses the last delivery route (falls back to WhatsApp).

To force a cheaper model for IMAP runs, set `model` in the mapping
(`provider/model` or alias). If you enforce `agents.defaults.models`, include it there.

To set a default model and thinking level specifically for IMAP hooks, add
`hooks.imap.model` / `hooks.imap.thinking` in your config:

```json5
{
  hooks: {
    imap: {
      allowedSenders: ["owner@example.com"],
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Notes:

- Per-hook `model`/`thinking` in the mapping still overrides these defaults.
- Fallback order: `hooks.imap.model` → `agents.defaults.model.fallbacks` → primary (auth/rate-limit/timeouts).
- If `agents.defaults.models` is set, the IMAP model must be in the allowlist.
- IMAP hook content is wrapped with external-content safety boundaries by default.
  To disable (dangerous), set `hooks.imap.allowUnsafeExternalContent: true`.
- `hooks.imap.allowedSenders` is required. Messages from other senders are ignored.
- The IMAP runtime also attempts to add the owner email from `USER.md` via an LLM-based
  extraction (only when explicitly stated), and merges it into the allowlist.

To customize payload handling further, add `hooks.mappings` or a JS/TS transform module
under `~/.openclaw/hooks/transforms` (see [Webhooks](/automation/webhook)).

## Wizard (recommended)

Use the OpenClaw helper to configure IMAP polling:

```bash
openclaw webhooks imap setup \
  --account my-email-account \
  --allowed-senders owner@example.com
```

The account name refers to a himalaya account. Run `himalaya account list` to see
configured accounts.

Defaults:

- Polls every 20 seconds (`--poll-interval 20`).
- Watches the `INBOX` folder (`--folder INBOX`).
- Includes body snippets up to 20KB (`--include-body` + `--max-bytes 20000`).
- Marks messages as seen after processing (`--mark-seen`).
- Query: `not flag Seen` (unread messages only).

To disable body snippets (headers only):

```bash
openclaw webhooks imap setup --account myaccount --include-body=false
```

To keep messages unread after processing:

```bash
openclaw webhooks imap setup --account myaccount --mark-seen=false
```

## Configuration Options

### Setup Command

```bash
openclaw webhooks imap setup \
  --account <name> \              # Required: himalaya account name
  --allowed-senders <emails> \    # Required: comma-separated allowlist
  --folder <name> \               # IMAP folder (default: INBOX)
  --poll-interval <seconds> \     # Poll interval (default: 20)
  --include-body \                # Include body snippets (default: true)
  --max-bytes <n> \               # Max body bytes (default: 20000)
  --mark-seen \                   # Mark as seen after processing (default: true)
  --query <query> \               # Envelope filter query (default: "not flag Seen")
  --hook-url <url> \              # Custom hook URL
  --hook-token <token> \          # Custom hook token
  --himalaya-config <path> \      # Path to himalaya config file
  --json                          # Output JSON summary
```

### Run Command

Run the IMAP watcher manually (useful for testing or ad-hoc runs):

```bash
openclaw webhooks imap run \
  --account <name> \              # himalaya account name
  --allowed-senders <emails> \    # Required: comma-separated allowlist
  --folder <name> \               # IMAP folder
  --poll-interval <seconds> \     # Poll interval
  --include-body \                # Include body snippets
  --max-bytes <n> \               # Max body bytes
  --mark-seen \                   # Mark as seen after processing
  --query <query> \               # Envelope filter query
  --hook-url <url> \              # Hook URL (required if not in config)
  --hook-token <token> \          # Hook token (required if not in config)
  --himalaya-config <path>        # Path to himalaya config file
```

The `run` command works even when `hooks.enabled` is false in your config,
as long as you provide `--hook-url` and `--hook-token` explicitly.

## How It Works

1. **Polling**: The watcher polls the IMAP server at configured intervals using
   `himalaya envelope list` to check for new messages matching the query.

2. **Body Reading**: When `includeBody=true`, the watcher fetches message content
   via `himalaya message read`. Body read failures are treated as fatal errors
   for that envelope (the message won't be marked as seen or delivered),
   ensuring at-least-once processing semantics.

3. **Delivery**: New messages are delivered to the configured hook URL as JSON:

   ```json
   {
     "messages": [
       {
         "id": "12345",
         "from": "sender@example.com",
         "subject": "Hello",
         "date": "2026-03-03T10:00:00Z",
         "snippet": "First 200 chars of body...",
         "body": "Full body (up to maxBytes)..."
       }
     ]
   }
   ```

4. **Mark Seen**: If `markSeen=true` and delivery succeeds, the message is marked
   as seen via `himalaya envelope flag add --flag Seen`.

5. **Deduplication**: The watcher maintains an in-memory set of seen message IDs
   (pruned to prevent unbounded growth). This prevents duplicate processing if
   `markSeen=false` or if the same message appears in multiple poll cycles.

## Gateway Integration

When `hooks.enabled=true` and `hooks.imap.account` is set, the Gateway starts
the IMAP watcher on boot:

```json5
{
  hooks: {
    enabled: true,
    imap: {
      account: "my-email-account",
      allowedSenders: ["owner@example.com"],
      folder: "INBOX",
      pollIntervalSeconds: 20,
      includeBody: true,
      maxBytes: 20000,
      markSeen: true,
      query: "not flag Seen",
    },
  },
}
```

Set `OPENCLAW_SKIP_IMAP_WATCHER=1` to opt out (useful if you run the watcher yourself).

## Manual Testing

Test himalaya connectivity:

```bash
# List accounts
himalaya account list

# List envelopes in INBOX
himalaya envelope list --account myaccount --folder INBOX

# Read a specific message
himalaya message read --account myaccount --folder INBOX 12345
```

Test the OpenClaw webhook endpoint:

```bash
curl -X POST http://127.0.0.1:18789/hooks/imap \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer OPENCLAW_HOOK_TOKEN" \
  -d '{"messages":[{"id":"test","from":"test@example.com","subject":"Test","date":"2026-03-03T10:00:00Z","snippet":"","body":""}]}'
```

## Troubleshooting

### "himalaya binary not found"

Install himalaya: <https://github.com/pimalaya/himalaya>

### "himalaya account check failed"

Run `himalaya account configure <account>` to set up the account, or check
`~/.config/himalaya/config.toml` for account configuration.

### "imap account required"

The `--account` flag is required. Run `himalaya account list` to see available accounts.

### Duplicate messages

- Check if `markSeen=true` is working (verify himalaya can modify flags).
- If `markSeen=false`, duplicates are prevented by the in-memory seen set,
  which is cleared on gateway restart.

### Messages not appearing

- Check the query filter: default is `not flag Seen` (unread only).
- Try `--query "all"` to match all messages.
- Verify folder name (case-sensitive on some servers).

### Connection errors

- Verify himalaya config: `himalaya account list`
- Check network connectivity to IMAP server.
- For Gmail, ensure "Less secure app access" or app-specific passwords are configured.

## Comparison: IMAP vs Gmail Pub/Sub

| Feature          | IMAP              | Gmail Pub/Sub          |
| ---------------- | ----------------- | ---------------------- |
| Latency          | Polling (seconds) | Push (near real-time)  |
| Setup            | Simple (himalaya) | Complex (GCP + gogcli) |
| Server support   | Any IMAP server   | Gmail only             |
| Mark as read     | Optional          | Always                 |
| Offline handling | Retries next poll | Missed messages\*      |

\*Pub/Sub history can be replayed, but requires additional setup.

Use IMAP when:

- You want simple setup without cloud dependencies
- You're using a non-Gmail IMAP server
- You want optional "mark as read" behavior
- Polling latency (20s default) is acceptable

Use Gmail Pub/Sub when:

- You need near real-time notifications
- You're already using GCP/gogcli
- You're on Gmail exclusively

## Cleanup

Remove IMAP configuration from your config:

```bash
openclaw config delete hooks.imap
```

Or edit `~/.openclaw/config.json` directly to remove the `hooks.imap` section.
