---
name: blink-sms
description: >
  Send SMS text messages to any phone number worldwide from the workspace's
  provisioned Twilio phone number. Use when asked to: text someone, send a
  notification via SMS, deliver an OTP or confirmation code, send an appointment
  reminder, order status update, shipping notification, or any alert by text
  message. Also use when asked to "message" or "ping" someone by phone.
  Requires the workspace to have a provisioned phone number — check with
  blink phone list, or buy one with blink phone buy. Charges 0.1 credits per message.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink SMS

Send SMS text messages from your workspace's phone number to any mobile number worldwide.

## Send a basic SMS

```bash
blink sms send "+14155551234" "Your appointment is confirmed for tomorrow at 2pm."
```

## Send from a specific number (when workspace has multiple)

```bash
blink sms send "+14155551234" "Your order #1042 has shipped!" --from "+19143720262"
```

## Common use cases

```bash
# OTP / verification code
blink sms send "+14155551234" "Your verification code is 492817. Expires in 10 minutes."

# Appointment reminder
blink sms send "+14155551234" "Reminder: your appointment is tomorrow at 3pm at 123 Main St."

# Order status
blink sms send "+14155551234" "Your order #1042 is ready for pickup at our store."

# Payment notification
blink sms send "+14155551234" "Your payment of $49.99 was received. Thank you!"

# Custom alert
blink sms send "+14155551234" "Alert: your server is down. CPU at 98%."
```

## International numbers

```bash
blink sms send "+447911123456" "Your verification code is 492817."
blink sms send "+61412345678" "Your order is ready for pickup."
blink sms send "+4915123456789" "Ihr Termin ist morgen um 14 Uhr bestätigt."
blink sms send "+33612345678" "Votre commande est prête."
```

## Get JSON output (for scripting / capturing result)

```bash
RESULT=$(blink sms send "+14155551234" "Hello" --json)
MESSAGE_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['message_id'])")
STATUS=$(echo "$RESULT" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['status'])")
```

## Check workspace phone numbers before sending

```bash
# List your workspace phone numbers
blink phone list

# Buy a number if you don't have one
blink phone buy --label "SMS"
```

## Phone number format

Always use E.164 format (country code + number, no spaces or dashes):
- US/Canada: `+14155551234`
- UK: `+447911123456`
- Australia: `+61412345678`
- Germany: `+4915123456789`
- France: `+33612345678`
- Japan: `+819012345678`

## Error handling

```bash
# Check if send succeeded
RESULT=$(blink sms send "+14155551234" "Hello" --json 2>&1)
if echo "$RESULT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); exit(0 if 'message_id' in d else 1)" 2>/dev/null; then
  echo "SMS sent successfully"
else
  echo "Error: $RESULT"
fi
```

Common errors:
- `No phone number provisioned` → run `blink phone buy` first
- `to must be in E.164 format` → add `+` country code prefix (e.g. `+14155551234`)
- `You're out of Blink credits` → add credits at blink.new/settings?tab=usage

### SMS never arrives on US phones (CLI says success, but no text)

The API returns `status: "queued"` when Twilio **accepts** the message. **Delivery** is separate.

If recipients on **US mobile** never get the text, check **Twilio → Monitor → Logs → Messaging** for **Undelivered** and error **30034** (*US A2P 10DLC – Message from an Unregistered Number*).

**Fix (Twilio account, not the agent):** Complete **A2P 10DLC** (Trust Hub: Brand + Campaign + link your US long code), **or** use **toll-free SMS** with **toll-free verification**. Until then, US carrier SMS from a normal long code is often blocked even though the CLI/API succeeded.

## Command signature

```
blink sms send <to> <message> [options]

Arguments:
  to        Recipient phone number in E.164 format (e.g. +14155551234)
  message   SMS message text (max 1600 characters)

Options:
  --from <number>   Specific sender number (default: workspace primary number)
  --json            Machine-readable JSON output
  --help            Show this help
```

## Response format (--json)

```json
{
  "message_id": "sms_a1b2c3d4",
  "twilio_sid": "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "status": "queued",
  "to": "+14155551234",
  "from": "+19143720262",
  "segment_count": 1,
  "credits_charged": 0.1
}
```

## Billing

- **0.1 credits per SMS** (flat rate for most messages — up to ~450 chars GSM or ~130 chars Unicode)
- Longer messages use multiple segments (153 chars/segment for GSM, 67 for Unicode/emoji)
- Credits are charged immediately when the SMS is sent, not deferred
- Check your credit balance: `blink whoami`
