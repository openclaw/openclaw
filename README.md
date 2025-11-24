# 📡 Warelay — WhatsApp Relay CLI (Twilio)

Small TypeScript CLI to send, receive, auto-reply, and inspect WhatsApp messages via Twilio. Works in polling mode or webhook mode (with Tailscale Funnel helper).

You can also use a personal WhatsApp Web session (QR login) via `--provider web` for direct sends alongside the Twilio flow.

## Quick Start

1) Install: `pnpm install`  
2) Configure `.env` (see `.env.example`): set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (or `TWILIO_API_KEY`/`TWILIO_API_SECRET`), and `TWILIO_WHATSAPP_FROM=whatsapp:+15551234567`. Optional: `TWILIO_SENDER_SID` if you don’t want auto-discovery.  
3) Send a test: `pnpm warelay send --to +12345550000 --message "Hi from warelay"`  
4) Run auto-replies in polling mode (no public URL needed):  
   `pnpm warelay poll --interval 5 --lookback 10 --verbose`  
5) Prefer webhooks? Launch everything in one step (webhook + Tailscale Funnel + Twilio callback):  
   `pnpm warelay up --port 42873 --path /webhook/whatsapp --verbose`

## Modes at a Glance

- **Polling (`monitor` / `poll`)**: Periodically fetch inbound messages to your WhatsApp number. Easiest to start; no ingress needed. Auto-replies still run.
- **Webhook (`webhook` / `up`)**: Push delivery from Twilio. `webhook` runs the server locally; `up` also enables Tailscale Funnel and points the Twilio sender/webhook to your public Funnel URL (with fallbacks to phone number and messaging service).

## Providers (choose per command)

- **Twilio (default)** — full feature set: send, wait/poll delivery, status, inbound polling/webhook, auto-replies. Requires `.env` Twilio creds and a WhatsApp-enabled number (`TWILIO_WHATSAPP_FROM`).
- **Web (`--provider web`)** — uses your personal WhatsApp Web session via QR. Currently **send-only** (no inbound/auto-reply/status yet) and returns immediately without delivery polling. Setup: `pnpm warelay web:login` then send with `--provider web`. Session data lives in `~/.warelay/waweb/`; if logged out, rerun `web:login`. Use at your own risk (personal-account automation can be rate-limited or logged out by WhatsApp).

## Common Commands

- Send: `pnpm warelay send --to +12345550000 --message "Hello" --wait 20 --poll 2`
- Send via personal WhatsApp Web: first `pnpm warelay web:login` (scan QR), then `pnpm warelay send --provider web --to +12345550000 --message "Hi"`
- Poll (lightweight): `pnpm warelay poll --interval 5 --lookback 10 --verbose`
- Webhook only: `pnpm warelay webhook --port 42873 --path /webhook/whatsapp --verbose`
- Webhook + Funnel + Twilio update: `pnpm warelay up --port 42873 --path /webhook/whatsapp --verbose`
- Status (recent sent/received): `pnpm warelay status --limit 20 --lookback 240` (add `--json` for machine-readable)

## Auto-Reply Config (JSON5 at `~/.warelay/warelay.json`)

### Claude-style example (your current setup)
```json5
{
  inbound: {
    allowFrom: ["***REMOVED***"], // optional allowlist (E.164, no whatsapp: prefix)
    reply: {
      mode: "command",
      bodyPrefix: "You are a helpful assistant running on the user's Mac. User writes messages via WhatsApp and you respond. You want to be concise in your responses, at most 1000 characters.\n\n",
      command: [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "{{Body}}"
      ]
    }
  }
}
```

### Simple text echo
```json5
{
  inbound: {
    reply: { mode: "text", text: "Echo: {{Body}}" }
  }
}
```

Notes:
- Templates support `{{Body}}`, `{{From}}`, `{{To}}`, `{{MessageSid}}`.
- When an auto-reply starts (text or command), warelay sends a WhatsApp typing indicator tied to the inbound `MessageSid`.

## Troubleshooting Delivery

- Auto-reply send failures now print in red with Twilio code/status and the response body (e.g., policy violation 63112). Watch terminal output when running `poll`, `webhook`, or `up`.
- Check recent messages: `pnpm warelay status --limit 20 --lookback 240`.
- If you must resend while a reply is long-running, keep messages <1600 chars (WhatsApp limit) and avoid restricted content/templates.

## Options Reference

| Field | Type / Values | Default | Description |
| --- | --- | --- | --- |
| `inbound.allowFrom` | `string[]` | empty | Allowlist of E.164 numbers (no `whatsapp:`). If set, only these trigger auto-replies. |
| `inbound.reply.mode` | `"text"` \| `"command"` | — | Auto-reply type. |
| `inbound.reply.text` | `string` | — | Reply body for text mode; templated. |
| `inbound.reply.command` | `string[]` | — | Argv to run for command mode; templated per element. Stdout (trimmed) is sent. |
| `inbound.reply.template` | `string` | — | Optional string inserted as second argv element (prompt prefix). |
| `inbound.reply.bodyPrefix` | `string` | — | Prepends to `Body` before templating (ideal for system instructions). |
| `inbound.reply.timeoutSeconds` | `number` | 600 | Command timeout. |

## Dev Notes

- During dev you can run without building: `pnpm dev -- <subcommand>` (e.g., `pnpm dev -- send --to +1...`).
- Stop polling/webhook with `Ctrl+C`. CLI uses `pnpm` and `tsx`; no build required for local runs.
