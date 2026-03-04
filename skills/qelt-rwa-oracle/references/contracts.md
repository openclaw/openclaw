# QXMP Oracle Smart Contracts

## Overview

Three smart contracts work together on QELT Mainnet to provide cryptographic proof-of-reserve for real-world assets. All deployed January 12, 2026 by deployer `0xBd6C978C38b0954e1153fB9892f007611726E2B0`.

> **Note:** Most developers should use the REST API (`api.qxmp.ai`) instead of reading contracts directly. The REST API reads from these contracts and enriches the data.

## Contract Addresses (QELT Mainnet, Chain ID 770)

| Contract | Address | Purpose |
|----------|---------|---------|
| `QXMPOracleController` | `0xB2a332dE80923134393306808Fc2CFF330de03bA` | Signature verification, signer management |
| `QXMPProofOfReserveV3` | `0x6123287acBf0518E0bD7F79eAcAaFa953e10a768` | Proof storage and audit trail |
| `QXMPDynamicRegistryV2` | `0xd00cD3a986746cf134756464Cb9Eaf024DF110fB` | Asset metadata, key-value storage |

## Ownership Architecture

```
Deployer (0xBd6C...E2B0)
└── ProofOfReserveV3 (0x6123...a768)
    └── DynamicRegistryV2 (0xd00c...10fB)
```

`ProofOfReserveV3` **owns** `DynamicRegistryV2`, enabling automatic value updates when new oracle proofs are submitted.

## Key Methods

### QXMPProofOfReserveV3 — Get Latest Proof

```
Function: getLatestProof(bytes32 assetCode, bytes32 dataFeedId)
Returns: (uint256 value, uint256 timestamp, address submitter, uint256 blockNumber)
```

**Example using curl + eth_call:**

```bash
# Asset code = keccak256("QXMP:RHENO-JORC-ZA")
# DataFeed ID = keccak256("QXMP:RHENO-JORC-ZA-FULL")
curl -fsSL -X POST https://mainnet.qelt.ai \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "method":"eth_call",
    "params":[{
      "to":"0x6123287acBf0518E0bD7F79eAcAaFa953e10a768",
      "data":"0x<ABI_ENCODED_CALL>"
    },"latest"],
    "id":1
  }'
```

> ABI encoding requires `getLatestProof` selector: compute `keccak256("getLatestProof(bytes32,bytes32)")[:4]`

### QXMPDynamicRegistryV2 — Get Asset

```
Function: getAsset(bytes32 assetCode)
Returns: (string assetName, string assetType, address holder, uint256 primaryValueUsd, uint256 registeredAt, uint256 lastUpdated, bool isActive)
```

## Value Encoding

Values are stored with **8 decimal precision**:

```
On-chain value = USD amount × 10^8
Example: $113,989,838,841.85 → stored as 11398983884185000000
Decode: value / 10^8 = USD amount
```

## Asset Code Generation

Asset codes use Keccak-256 hashing:

```
assetCode = keccak256("QXMP:RHENO-JORC-ZA")
```

Format: `QXMP:{PROJECT}-{STANDARD}-{COUNTRY}`

## Security Features

| Feature | Details |
|---------|---------|
| Signature Standard | EIP-191 (ECDSA, secp256k1) |
| Staleness Protection | 24-hour default freshness requirement |
| Access Control | Only authorized signers can submit proofs |
| Audit Trail | Immutable history — proofs cannot be modified or deleted |
| Soft Delete | Fields can be soft-deleted for regulatory compliance |

## Explorer Links

- [OracleController on QELTScan](https://qeltscan.ai/address/0xB2a332dE80923134393306808Fc2CFF330de03bA)
- [ProofOfReserveV3 on QELTScan](https://qeltscan.ai/address/0x6123287acBf0518E0bD7F79eAcAaFa953e10a768)
- [DynamicRegistryV2 on QELTScan](https://qeltscan.ai/address/0xd00cD3a986746cf134756464Cb9Eaf024DF110fB)
