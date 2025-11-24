# 📡 Warelay — WhatsApp Relay CLI (Twilio)

Small TypeScript CLI to send, monitor, and webhook WhatsApp messages via Twilio. Supports Tailscale Funnel and config-driven auto-replies.

## Setup

1. `pnpm install`
2. Copy `.env.example` to `.env` and fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM` (use your approved WhatsApp-enabled Twilio number, prefixed with `whatsapp:`).
   - Alternatively, use API keys: `TWILIO_API_KEY` + `TWILIO_API_SECRET` instead of `TWILIO_AUTH_TOKEN`.
   - Optional: `TWILIO_SENDER_SID` to skip auto-discovery of the WhatsApp sender in Twilio.
3. Build once for the runnable bin: `pnpm build`

## Commands

- Send: `pnpm warelay send --to +15551234567 --message "Hello" --wait 20 --poll 2`
  - `--wait` seconds (default 20) waits for a terminal delivery status; exits non-zero on failed/undelivered/canceled.
  - `--poll` seconds (default 2) sets the polling interval while waiting.
- Monitor (polling): `pnpm warelay monitor` (defaults: 5s interval, 5m lookback)
  - Options: `--interval <seconds>`, `--lookback <minutes>`
- Webhook (push, works well with Tailscale): `pnpm warelay webhook --port 42873 --reply "Got it!"`
  - Points Twilio’s “Incoming Message” webhook to `http://<your-host>:42873/webhook/whatsapp`
  - With Tailscale, expose it: `tailscale serve tcp 42873 127.0.0.1:42873` and use your tailnet IP.
  - Customize path if desired: `--path /hooks/wa`
  - If no `--reply`, auto-reply can be configured via `~/.warelay/warelay.json` (JSON5)
- Setup helper: `pnpm warelay setup --port 42873 --path /webhook/whatsapp`
  - Validates Twilio env, confirms `tailscale` binary, starts the webhook, enables Tailscale Funnel, and sets the Twilio incoming webhook to your Funnel URL.
  - Requires Tailscale Funnel to be enabled for your tailnet/device (admin setting). If it isn’t enabled, the command will exit with instructions; alternatively expose the webhook via your own tunnel and set the Twilio URL manually.

## Config-driven auto-replies

Put a JSON5 config at `~/.warelay/warelay.json`. Examples:

```json5
{
  inbound: {
    // Static text reply with templating
    reply: { mode: 'text', text: 'Echo: {{Body}}' }
  }
}

// Command-based reply (stdout becomes the reply)
{
  inbound: {
    reply: {
      mode: 'command',
      command: ['bash', '-lc', 'echo "You said: {{Body}} from {{From}}"']
    }
  }
}
```

During dev you can run without building: `pnpm dev -- <subcommand>` (e.g. `pnpm dev -- send --to +1...`).

## Notes

- Monitor uses polling; webhook mode is push (recommended).
- Stop monitor/webhook with `Ctrl+C`.
