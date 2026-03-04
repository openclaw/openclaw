---
name: qelt-rwa-oracle
description: "Fetch real-world asset (RWA) data and proof-of-reserve status from the QXMP Oracle — managing $1.1 trillion in certified in-ground mining assets on the QELT blockchain. Use when asked about tokenized assets, reserve proofs, asset valuations, QXMP portfolio stats, or proof freshness. No API key required."
homepage: https://qxmp.ai
metadata: { "openclaw": { "emoji": "🏦", "requires": { "bins": ["curl"] } } }
---

# QXMP Oracle Skill (RWA Proof-of-Reserve)

The QXMP Oracle is a custom oracle infrastructure (not Chainlink or RedStone) providing cryptographically verified real-world asset data on the QELT blockchain. It manages **12 tokenized mining projects** worth approximately **$1.1 trillion USD**.

**API Base URL:** `https://api.qxmp.ai/api/v1/rwa`
**Auth:** None required — fully public API
**CORS:** Enabled — works from any browser
**Update frequency:** Oracle proofs update ~once per 24 hours

## Safety

- Read-only API — no write operations available.
- Never fabricate asset valuations, proof timestamps, or freshness status.
- Always report `isFresh` honestly — a stale proof (`isFresh: false`) means data may be up to 1 day old.
- Parse `valueUSD` fields with `parseFloat()` — they are strings to preserve precision.
- Respect rate limits: exponential backoff on `HTTP 429` using `Retry-After` header.
- Cache responses for 2–5 minutes; proofs are stable between daily updates.

## Endpoints

### Health Check

```bash
curl -fsSL "https://api.qxmp.ai/api/v1/rwa/health"
```

### Get All Assets (primary endpoint)

```bash
curl -fsSL "https://api.qxmp.ai/api/v1/rwa/assets?page=1&limit=100"
```

Key fields per asset:

| Field | Type | Notes |
|-------|------|-------|
| `assetCode` | string | e.g. `"QXMP:RHENO-JORC-ZA"` |
| `name` | string | Human-readable project name |
| `type` | string | Gold, Diamond, Rare Earth Elements, etc. |
| `jurisdiction` | string | ZA, NA, MZ, LR, AU |
| `valueUSD` | string | Parse with `parseFloat()` |
| `latestProof.isFresh` | boolean | `true` if proof < 24h old |
| `latestProof.ageHours` | string | Hours since last proof |
| `latestProof.timestamp` | string | ISO 8601 |

### Get Single Asset

```bash
# URL-encode the colon in the asset code
curl -fsSL "https://api.qxmp.ai/api/v1/rwa/assets/QXMP:RHENO-JORC-ZA"
```

Returns full asset details including `onChain` data and `proofHistory[]`.

### Get Portfolio Statistics

```bash
curl -fsSL "https://api.qxmp.ai/api/v1/rwa/stats"
```

Returns `totalAssets`, `totalValue`, `averageValue`, `byType[]`, `byJurisdiction[]`.

## Response Shape

```json
{
  "success": true,
  "data": {
    "assets": [
      {
        "assetCode": "QXMP:RHENO-JORC-ZA",
        "name": "Rhenosterspruit / Syferfontein Mining Project",
        "type": "Rare Earth Elements",
        "jurisdiction": "ZA",
        "valueUSD": "113989838841.85",
        "status": "registered",
        "latestProof": {
          "valueUSD": "113989838841.85",
          "timestamp": "2026-02-10T12:00:00.000Z",
          "ageHours": "23.5",
          "isFresh": true,
          "submitter": "0x..."
        }
      }
    ],
    "summary": { "count": 12, "totalValue": "1090958787645.94", "currency": "USD" }
  }
}
```

## Procedure

### Report Asset Portfolio

1. Fetch: `GET /assets?page=1&limit=100`
2. Check `success: true`
3. Parse each `valueUSD` with `parseFloat()`
4. Flag ✅ Fresh or ⚠️ Stale per `latestProof.isFresh`
5. Report totals from `data.summary.totalValue`

### Verify a Specific Asset

1. Fetch: `GET /assets/{assetCode}`
2. Report: name, type, jurisdiction, value, proof age, freshness
3. If `isFresh: false`, warn user proof is older than 24 hours

### Rate Limit Handling

```bash
# Check for 429 and respect Retry-After
response=$(curl -sI "https://api.qxmp.ai/api/v1/rwa/assets")
if echo "$response" | grep -q "HTTP/.*429"; then
  retry=$(echo "$response" | grep -i "retry-after" | awk '{print $2}' | tr -d '\r')
  echo "Rate limited. Waiting ${retry}s..."
  sleep "$retry"
fi
```

## Smart Contracts (On-Chain — Advanced)

For trustless verification without the REST API:

| Contract | Address | Role |
|----------|---------|------|
| OracleController | `0xB2a332dE80923134393306808Fc2CFF330de03bA` | Signature verification |
| ProofOfReserveV3 | `0x6123287acBf0518E0bD7F79eAcAaFa953e10a768` | Proof storage + audit trail |
| DynamicRegistryV2 | `0xd00cD3a986746cf134756464Cb9Eaf024DF110fB` | Asset metadata storage |

Asset codes: `keccak256("QXMP:RHENO-JORC-ZA")` — format `QXMP:{PROJECT}-{STANDARD}-{COUNTRY}`.
Values stored at 8 decimal precision: `valueUSD * 10^8`.

## Asset Types

Gold · Diamond · Rare Earth Elements · Heavy Mineral Sands · Nickel and Cobalt · Platinum · Lithium · Uranium

## Jurisdictions

ZA (South Africa) · NA (Namibia) · MZ (Mozambique) · LR (Liberia) · AU (Australia)

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `success: false` | API error | Check `error` field |
| HTTP 429 | Rate limited | Wait `Retry-After` seconds |
| Asset not found | Wrong code | List all via `/assets` first |
| `isFresh: false` | Proof > 24h old | Data valid; oracle updates daily |
