---
name: blink-call
description: >
  Make outbound AI phone calls to any US or international phone number.
  The AI agent speaks and listens interactively in real-time using natural voice.
  Use when asked to call someone, make a phone call, speak to a person,
  collect information by phone, confirm an appointment, or deliver a voice
  message to a real number. The primary workspace number is used by default;
  use --from to specify a different number. Charges workspace credits.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink AI Call

Make outbound AI phone calls where the agent speaks and listens interactively.
The conversation is driven by a system prompt you provide — the agent can handle
questions, follow a script, collect information, and respond naturally.

## Make a call (waits for completion, prints transcript)
```bash
blink ai call "+14155551234" "You are collecting a $240 payment from John Smith for invoice #1042. Be polite but firm. Offer a payment plan if needed."
```

## Call from a specific number (when workspace has multiple)
```bash
blink ai call "+14155551234" "You are a sales rep following up on a demo." --from "+19143720262"
```

## International calls
```bash
blink ai call "+447911123456" "Confirm Jane Doe's appointment tomorrow at 3pm at our London office."
blink ai call "+61412345678" "You are following up on the contract sent last week."
```

## Specific voice
```bash
blink ai call "+14155551234" "You are a friendly customer support agent." --voice openai:nova
```

## Fire and forget (returns call_id immediately, doesn't wait)
```bash
blink ai call "+14155551234" "Leave a voicemail about our product launch on March 25th." --no-wait
```

## Check status of a previous call
```bash
blink ai call-status vc_a1b2c3d4
blink ai call-status vc_a1b2c3d4 --json
```

## Get JSON output (for scripting)
```bash
RESULT=$(blink ai call "+14155551234" "Your task here." --json)
TRANSCRIPT=$(echo "$RESULT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('transcript',''))")
```

## Phone number format
Always use E.164 format:
- US/Canada: `+14155551234`
- UK: `+447911123456`
- Australia: `+61412345678`
- Germany: `+4915123456789`

## System prompt tips
- Be specific about the agent's role and goal
- Include relevant context (name, amount, date, reference numbers)
- Specify what to do on voicemail, if refused, or if line is busy
- Example: "You are calling on behalf of Acme Corp to confirm John Smith's appointment on March 20th at 2pm. If he needs to reschedule, offer March 21st at 10am or 3pm. If you reach voicemail, leave a brief message and say we'll call back."

## Available voices
| Voice | Style |
|-------|-------|
| `openai:alloy` | Balanced, neutral (default) |
| `openai:nova` | Friendly, warm |
| `openai:echo` | Clear, conversational |
| `openai:onyx` | Deep, authoritative |
| `openai:shimmer` | Soft, gentle |
| `cartesia:sonic-english` | Very low latency, natural |

## Command signatures
```
blink ai call <phone-number> <system-prompt> [options]
  --voice <voice>           Voice to use (default: openai:alloy)
  --max-duration <seconds>  Max call duration (default: 300)
  --no-wait                 Return immediately without waiting for completion
  --from <number>           Specific outbound number to call from
  --json                    Machine-readable output

blink ai call-status <call-id> [--json]
```

## Response format (--json)
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
Before making calls, ensure your workspace has a phone number: `blink phone list`
