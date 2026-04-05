---
tags:
  - dmarket
  - api
  - trading
category: domain-knowledge
difficulty: beginner
training: true
created: 2026-03-29
---

# Dmarket API — Core Reference

#v16_knowledge

## Base URL

https://api.dmarket.com

## Authentication

Bearer token via Authorization header.

## Key Endpoints

- GET /exchange/v1/market/items — list market items
- POST /exchange/v1/offers — place sell offer
- DELETE /exchange/v1/offers/{offerId} — cancel offer

## Error Codes

- 401: Unauthorized (invalid/expired token)
- 429: Rate limit exceeded (back-off 60s)
- 404: Item/offer not found
- 500: Internal server error (retry with exponential backoff)

## Notes

- Sign requests with HMAC-SHA256: sign = HMAC(secret, method + path + timestamp + body)
- Timestamp header: X-Api-Key, X-Request-Sign, X-Sign-Date
