---
name: serenai
description: Query databases and APIs via SerenAI gateway. Pay-per-query access to SQL databases, web scraping, and search APIs.
homepage: https://serendb.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🌊",
        "requires": { "bins": ["curl"], "env": ["SEREN_API_KEY"] },
        "primaryEnv": "SEREN_API_KEY",
      },
  }
---

# SerenAI

Query databases and call APIs through SerenAI's gateway. Pay per query with a prepaid wallet.

## Setup

Register (no auth required):

```bash
curl -X POST https://api.serendb.com/auth/agent \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'
```

Save the `api_key` from response:

```bash
export SEREN_API_KEY="seren_xxxx"
```

## Commands

Check balance:

```bash
curl https://api.serendb.com/wallet/balance \
  -H "Authorization: Bearer $SEREN_API_KEY"
```

List publishers:

```bash
curl https://api.serendb.com/publishers
```

Query a database:

```bash
curl -X POST "https://api.serendb.com/publishers/{slug}/query" \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM table LIMIT 10"}'
```

Call an API:

```bash
curl -X POST "https://api.serendb.com/publishers/{slug}/proxy" \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"method": "GET", "path": "/v1/endpoint"}'
```

Estimate cost:

```bash
curl -X POST "https://api.serendb.com/publishers/{slug}/estimate" \
  -H "Authorization: Bearer $SEREN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT * FROM large_table"}'
```

Claim free daily credits:

```bash
curl -X POST https://api.serendb.com/wallet/free-credits/claim \
  -H "Authorization: Bearer $SEREN_API_KEY"
```

## Notes

- Pricing: ~$0.001-0.10 per call (varies by publisher)
- Use `LIMIT` clauses to control query costs
- Check balance before expensive operations
