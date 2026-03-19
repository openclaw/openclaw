---
name: blink-phone
description: >
  Manage workspace phone numbers for AI calling. Buy dedicated phone numbers,
  list existing numbers, update labels, and release numbers. Each number costs
  25 credits/month and is billed independently. Use before making AI calls to
  ensure a number is provisioned. The oldest active number is used by default
  for blink ai call; use --from to specify others.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink Phone

Manage workspace phone numbers for AI calling via `blink phone`.

## List all workspace phone numbers
```bash
blink phone list
blink phone list --json
```
Output shows: number, label, status (● active / ⚡ grace), ★ primary badge, next charge date.

## Buy a new phone number
```bash
# Any available US number
blink phone buy --label "Sales"

# Specific area code (preferred — Vapi picks closest available)
blink phone buy --label "Primary" --area-code 914
blink phone buy --label "Support" --area-code 826
blink phone buy --label "Outreach" --area-code 775

# International
blink phone buy --label "UK Line" --country GB
blink phone buy --label "Canada" --country CA
blink phone buy --label "Australia" --country AU

# Get JSON (useful for scripting)
NUMBER=$(blink phone buy --label "Bot" --area-code 914 --json | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['phone_number'])")
```
Costs 25 credits immediately (first month), then 25 credits/month recurring.

## Update a number's label
```bash
blink phone label wpn_abc12345 "Sales"
blink phone label wpn_abc12345 "Support line"
blink phone label wpn_abc12345 ""   # Clear label
```
Get the ID from `blink phone list --json | python3 -c "import json,sys; print(json.loads(sys.stdin.read())[0]['id'])"`.

## Release (cancel) a number
```bash
blink phone release wpn_abc12345 --yes   # Skip confirmation
blink phone release wpn_abc12345         # Interactive confirmation
```
The number is permanently returned to the pool. Cannot be undone.

## Full self-provisioning flow (agent buys its own number and calls)
```bash
# 1. Check if a number exists
NUMBERS=$(blink phone list --json)
COUNT=$(echo "$NUMBERS" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))")

# 2. Buy one if none exists
if [ "$COUNT" -eq 0 ]; then
  blink phone buy --label "Primary" --area-code 914
fi

# 3. Get the primary number
FROM=$(blink phone list --json | python3 -c "import json,sys; print(json.loads(sys.stdin.read())[0]['phone_number'])")

# 4. Make a call from that number
blink ai call "+14155551234" "Your task here." --from "$FROM"
```

## Command signatures
```
blink phone                          # Alias for list
blink phone list [--json]
blink phone buy [--label <name>] [--country US|GB|CA|AU] [--area-code <3digits>] [--json]
blink phone label <id> <label>
blink phone release <id> [--yes] [--json]
```

## Available area codes (US)
Vapi suggests: `914` (NY), `826` (CA), `775` (NV) — others may be available.
If an area code is unavailable, Vapi returns the error: "This area code is not available. Hint: Try one of 914, 826, 775."

## Billing
- 25 credits charged immediately on buy (first month)
- 25 credits charged monthly on anniversary date
- Numbers in grace period (payment failed) pause calls for 7 days then are released
- 1 credit = $0.25 · 25 credits/month = $2.50/month per number
