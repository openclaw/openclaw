# QELT Contract Verification — Reference Guide

## API Base URL

| Network | Base URL |
|---------|----------|
| Mainnet | `https://mnindexer.qelt.ai` |
| Testnet | `https://tnindexer.qelt.ai` |

## Verification Endpoints

| Method | Path | Description | Rate Limited |
|--------|------|-------------|--------------|
| POST | `/api/v1/verification/submit` | Single-file verification | ✅ 10/hour |
| POST | `/api/v1/verification/submit-multi` | Multi-file verification | ✅ 10/hour |
| GET | `/api/v1/verification/status/:jobId` | Poll job status | ❌ Unlimited |
| GET | `/api/v2/contracts/:address/verification` | Get verified contract | ❌ |
| GET | `/api/v2/verification/compiler-versions` | List 500+ Solidity versions | ❌ |
| GET | `/api/v2/verification/evm-versions` | List EVM versions | ❌ |

## Job Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Job queued, not yet started |
| `processing` | Compilation in progress |
| `completed` | Job finished — check `result.verified` |
| `failed` | Job failed — check `message` field |

## ⚠️ Important: Check `result.verified`

A job can have `status: "completed"` with `result.verified: false` (bytecode mismatch). **Always verify:**

```json
{
  "status": "completed",
  "result": {
    "verified": true   ← THIS must be true
  }
}
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

QELT Mainnet is **Cancun** — use `cancun` for Solidity 0.8.24+.

## Compiler Version Formats

Both formats accepted:
- `"0.8.20"` (short)
- `"v0.8.20+commit.8a97fa7a"` (full commit hash)

## Submit Request Bodies

### Single-File (`/api/v1/verification/submit`)

```json
{
  "address": "0x...",
  "sourceCode": "// SPDX-License-Identifier: MIT\npragma solidity ...",
  "compilerVersion": "0.8.20",
  "contractName": "MyContract",
  "optimizationUsed": true,
  "runs": 200,
  "evmVersion": "shanghai",
  "constructorArguments": "0x000...",
  "libraries": {
    "SafeMath": "0xABC..."
  }
}
```

### Multi-File (`/api/v1/verification/submit-multi`)

```json
{
  "address": "0x...",
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
}
```

## Success Response

```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "statusUrl": "/api/v1/verification/status/550e8400-..."
}
```

## Rate Limit Response (HTTP 429)

```json
{
  "success": false,
  "error": "Too many requests",
  "message": "Rate limit exceeded. Max 10 requests per hour.",
  "retryAfter": 3600
}
```

## IP Blocked Response (HTTP 403)

```json
{
  "success": false,
  "error": "IP address blocked",
  "message": "Rate limit exceeded",
  "blockedUntil": "2026-01-20T14:51:00.000Z"
}
```

## Rate Limit Headers

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1737373200
Retry-After: 3600
```

## Common Verification Failures

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `verified: false` | Wrong compiler version | Use exact version from deployment |
| `verified: false` | Wrong optimization settings | Match `optimizationUsed` + `runs` from deployment |
| `verified: false` | Missing constructor args | ABI-encode constructor arguments |
| `verified: false` | Wrong viaIR setting | Enable `"viaIR": true` if compiled with IR |
| `status: failed` | Compilation error | Fix source code; check `message` |
| Timeout | Large contract | Wait — result arrives after up to 10 minutes |

## Hardhat Plugin

Latest version: `@qelt/hardhat-verify@1.0.12`

```bash
npm install --save-dev @qelt/hardhat-verify@latest
npx hardhat qelt:verify --network qelt 0xCONTRACT_ADDRESS
```

Features: auto-detects viaIR, EVM version, routes single vs multi-file automatically.

## CLI Tool

Latest version: `qelt-verify@1.1.0`

```bash
npm install -g qelt-verify
qelt-verify init
qelt-verify verify 0xCONTRACT ./Contract.sol --compiler-version 0.8.20 --optimize --watch
```
