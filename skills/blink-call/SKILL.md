---
name: blink-call
description: >
  Make outbound AI phone calls to any US or international phone number.
  The AI agent speaks interactively in real-time using natural voice.
  Use when asked to call someone, make a phone call, speak to a person,
  collect information by phone, confirm an appointment, or deliver
  a voice message to a real phone number. Charges workspace credits.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink AI Call

Make outbound AI phone calls where the agent speaks and listens interactively.
The agent on the call uses full AI capabilities — it can handle questions,
follow a script, collect information, and respond naturally.

## Make a call (wait for completion)
```bash
bash scripts/call.sh "+14155551234" "You are collecting a $240 payment from John Smith for invoice #1042. Be polite but firm. Offer a payment plan if needed."
```

## Make a call — international
```bash
bash scripts/call.sh "+447911123456" "Confirm the appointment for Jane Doe tomorrow at 3pm at our London office."
```

## Make a call — specific voice
```bash
bash scripts/call.sh "+14155551234" "You are a customer service agent following up on order #5521." "openai:nova"
```

## Start a call and continue without waiting
```bash
bash scripts/call-nowait.sh "+14155551234" "Leave a voicemail about our product launch on March 25th."
```

## Check call status
```bash
bash scripts/status.sh "vc_a1b2c3d4"
```

## Phone number format
Always use E.164 format: +1 for US/Canada, +44 for UK, +61 for Australia, etc.
- US: `+14155551234`
- UK: `+447911123456`
- Australia: `+61412345678`

## System prompt tips
- Be specific about the agent's role and goal
- Include relevant context (name, amount, date, etc.)
- Specify what to do if voicemail, if refused, etc.
- Example: "You are calling on behalf of Acme Corp to confirm John Smith's appointment on March 20th at 2pm. If he needs to reschedule, offer March 21st at 10am or 3pm."

## Available voices
| Voice | Style |
|-------|-------|
| `openai:alloy` | Balanced, neutral (default) |
| `openai:nova` | Friendly, warm |
| `openai:echo` | Clear, conversational |
| `openai:onyx` | Deep, authoritative |
| `openai:shimmer` | Soft, gentle |
| `cartesia:sonic-english` | Very low latency, natural |

## Response format
```json
{
  "call_id": "vc_a1b2c3d4",
  "status": "completed",
  "duration_seconds": 87,
  "transcript": "Agent: Hello, is this John Smith?\nUser: Yes, speaking.\n...",
  "credits_charged": 2
}
```

## Billing
~1 credit per minute of call duration. Credits are charged after the call ends.
