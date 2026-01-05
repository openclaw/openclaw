---
name: steve-auth
description: Multi-tenant authentication and permissions for Steve based on ppl.gift tags.
---

# Steve Auth

Multi-user access control using ppl.gift as the identity provider.

## How It Works

1. Incoming message arrives with phone number
2. Lookup phone in ppl.gift → get contact + tags
3. Apply permissions based on tag membership
4. Unknown users get minimal/no access

## Permission Groups (Tags)

| Tag | Skills | Description |
|-----|--------|-------------|
| Family | ALL | Full access to everything |
| Work | twenty, gog (work calendar), brave-search | One Point team access |
| Extended Family | brave-search, weather, ppl | Extended family with basic access |
| (no tag) | NONE or basic Q&A only | Unknown users |

## Commands

```bash
# Lookup user by phone
./scripts/steve-auth.py lookup "+15551234567"

# Check permissions for a user
./scripts/steve-auth.py check "+15551234567" --skill twenty

# List all authorized users
./scripts/steve-auth.py users
```

## Files
- `permissions.json` — Tag-to-skill mappings
- `scripts/steve-auth.py` — Lookup and permission checking
