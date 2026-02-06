# ArmorIQ Intent Demo (OpenClaw)

This folder contains assets for the ArmorIQ intent-enforcement demo, including CSRG verification
via `/tools/invoke`.

## Quick Start

1. Enable the ArmorIQ plugin with valid credentials (see `AIQREADME.md`).
2. Connect Slack and Telegram.
3. Ensure tools are allowed: `web_search`, `web_fetch`, `browser`, `read`, `write`, `message`.
4. Run `pnpm aiq:demo setup`.

## Baseline (No ArmorIQ)

1. Temporarily set `plugins.entries.armoriq.enabled: false`.
2. Restart OpenClaw.
3. Run Segment 2 from `aiqdemo/prompts.md`.
4. Re-enable the plugin and restart OpenClaw.

## Prompts

Prompts live in `aiqdemo/prompts.md` and can be printed with:

```
pnpm aiq:demo prompts
```

## /tools/invoke Segments

Run the HTTP demo steps with:

```
pnpm aiq:demo invoke --segment=5a,5b,5c,5d
```

Environment variables:

- `AIQ_DEMO_GATEWAY_URL` (default `http://localhost:18789`)
- `AIQ_DEMO_GATEWAY_TOKEN` (required)
- `AIQ_DEMO_ARMORIQ_API_KEY` or `ARMORIQ_API_KEY` (segment 5B auto-mint)
- `AIQ_DEMO_USER_ID` or `USER_ID` (segment 5B auto-mint)
- `AIQ_DEMO_AGENT_ID` or `AGENT_ID` (segment 5B auto-mint)
- `AIQ_DEMO_CONTEXT_ID` or `CONTEXT_ID` (segment 5B auto-mint, default `default`)
- `AIQ_DEMO_IAP_BACKEND_URL` or `IAP_BACKEND_URL` or `BACKEND_ENDPOINT` (segment 5B auto-mint)
- `AIQ_DEMO_IAP_ENDPOINT` or `IAP_ENDPOINT` (segment 5B/5D auto-mint, optional)
- `AIQ_DEMO_PROXY_ENDPOINT` or `PROXY_ENDPOINT` (segment 5B/5D auto-mint, optional)
- `AIQ_DEMO_INTENT_POLICY` (or `AIQ_DEMO_POLICY`) (segment 5B auto-mint, JSON object string)
- `AIQ_DEMO_INTENT_VALIDITY_SECONDS` (segment 5B auto-mint, default `60`)
- `AIQ_DEMO_MESSAGE_CHANNEL` (optional, sets `x-openclaw-message-channel`)

## Expected Results

- Segment 1: tool plan is honored and succeeds.
- Segment 2: any unplanned tool is blocked with intent drift.
- Segment 3: `read` + `message send`.
- Segment 4: `browser` + `message send`.
- Segment 5A: allowed (single-step plan minted).
- Segment 5B: allowed only if `web_fetch` is in the token plan.
- Segment 5C: blocked (missing plan).
- Segment 5D: allowed only if IAP `verify-step` allows and CSRG proofs validate.
  - Segment 5D auto-uses CSRG proofs from the IAP-issued token. If no proofs are returned,
    the segment is skipped with "No CSRG proofs captured from IAP."
  - If the token does not include a CSRG value digest, the demo computes a sha256 of the
    JSON-stringified action name (same as the SDK).
