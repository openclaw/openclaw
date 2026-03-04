---
name: qelt-contracts
description: "Verify and inspect smart contracts on the QELT blockchain using the Mainnet Indexer verification API. Use when asked to verify Solidity source code, check if a contract is verified, retrieve ABIs, list compiler versions, poll a verification job, or submit multi-file contracts (with OpenZeppelin imports). Rate limit: 10 submissions/hour."
homepage: https://mnindexer.qelt.ai
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": ["curl"] } } }
---

# QELT Smart Contract Verification Skill

The QELT Mainnet Indexer provides production-grade contract verification via REST API. Supports 500+ Solidity versions, constructor arguments, library linking, multi-file contracts (75+ files), viaIR compilation, and automatic EVM version detection.

**API Base:** `https://mnindexer.qelt.ai`
**Rate Limit:** 10 verification submissions per hour per IP
**Timeout per job:** 600 seconds (10 minutes)
**Status polling:** Unlimited — poll every 3–5 seconds freely

## Safety

- Do not submit source code containing private keys or secrets.
- Verification is permanent — source becomes public once verified.
- Always check if already verified **before** submitting (saves rate limit quota).
- `status: "completed"` does NOT mean verified — always check `result.verified === true`.
- Status polling is unlimited — do not re-submit while a job is still processing.

## Procedure

### 1. Check if Already Verified (Do This First)

```bash
curl -fsSL "https://mnindexer.qelt.ai/api/v2/contracts/0xCONTRACT/verification"
```

If `"verified": true` → return existing source/ABI to user, no submission needed.

### 2. Submit Single-File Contract

```bash
curl -fsSL -X POST "https://mnindexer.qelt.ai/api/v1/verification/submit" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xCONTRACT",
    "sourceCode": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n...",
    "compilerVersion": "0.8.20",
    "contractName": "MyContract",
    "optimizationUsed": true,
    "runs": 200,
    "evmVersion": "cancun",
    "constructorArguments": "0x000...",
    "libraries": {}
  }'
```

Response: `{ "success": true, "jobId": "uuid", "statusUrl": "/api/v1/verification/status/uuid" }`

### 3. Submit Multi-File Contract (with imports)

For contracts using OpenZeppelin or any `import` statements:

```bash
curl -fsSL -X POST "https://mnindexer.qelt.ai/api/v1/verification/submit-multi" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xCONTRACT",
    "compilerVersion": "v0.8.17+commit.8df45f5f",
    "contractName": "MyToken",
    "optimizationUsed": true,
    "runs": 200,
    "viaIR": true,
    "evmVersion": "london",
    "mainFile": "contracts/MyToken.sol",
    "sourceFiles": {
      "contracts/MyToken.sol": "pragma solidity ^0.8.17; ...",
      "@openzeppelin/contracts/token/ERC20/ERC20.sol": "..."
    }
  }'
```

### 4. Poll Status (Unlimited)

```bash
curl -fsSL "https://mnindexer.qelt.ai/api/v1/verification/status/JOB_ID"
```

States: `pending` → `processing` → `completed` / `failed`

⚠️ After `"completed"`, always verify `result.verified === true`:

```json
{
  "status": "completed",
  "result": { "verified": true, "abi": [...] }
}
```

`verified: false` with `status: "completed"` = bytecode mismatch.

### 5. Get Compiler Versions

```bash
curl -fsSL "https://mnindexer.qelt.ai/api/v2/verification/compiler-versions"
```

### 6. Get EVM Versions

```bash
curl -fsSL "https://mnindexer.qelt.ai/api/v2/verification/evm-versions"
```

## EVM Version Selection

| Solidity Range | EVM Version |
|---------------|-------------|
| 0.5.14 – 0.8.4 | `istanbul` |
| 0.8.5 | `berlin` |
| 0.8.6 – 0.8.17 | `london` |
| 0.8.18 – 0.8.19 | `paris` |
| 0.8.20 – 0.8.23 | `shanghai` |
| 0.8.24+ | `cancun` |

QELT Mainnet runs EVM **Cancun** — use `cancun` for Solidity 0.8.24+.

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `POST /api/v1/verification/submit` | 10 req/hour per IP |
| `POST /api/v1/verification/submit-multi` | 10 req/hour per IP |
| `GET /api/v1/verification/status/:jobId` | Unlimited |
| All other GET endpoints | Not rate limited |

Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`.

## Common Errors

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `verified: false` (completed) | Wrong compiler/optimization/args | Match exact deployment settings |
| HTTP 429 | Rate limited | Wait `Retry-After` seconds (usually 3600) |
| `status: "failed"` | Compilation error | Check `message` field |
| Timeout at 600s | Large contract + viaIR | Normal; job still finishes |

## Best Practices

1. Check before submit — use `GET /api/v2/contracts/:address/verification` first
2. Use `/submit-multi` for any contract with `import` statements
3. Include `"viaIR": true` if compiled with `viaIR: true` in hardhat config
4. Poll every 3–5 seconds — do not re-submit a pending job

## Developer Tools

**Hardhat Plugin:** `npm install --save-dev @qelt/hardhat-verify@latest`

```bash
npx hardhat qelt:verify --network qelt 0xCONTRACT_ADDRESS
```

**CLI Tool:** `npm install -g qelt-verify` → `qelt-verify verify 0x... ./Contract.sol --compiler-version 0.8.20 --optimize`
