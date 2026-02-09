---
name: endaoment
description: Donate to charities onchain via Endaoment. Use when the user wants to donate crypto to charity, make a charitable contribution, give to nonprofits, support a cause, or donate to a 501(c)(3). Supports Base, Ethereum, and Optimism. Handles USDC donations directly or swaps ETH/tokens to USDC automatically.
metadata: {"openclaw":{"emoji":"💝","homepage":"https://endaoment.org"}}
---

# Endaoment Charity Donations

Donate to 501(c)(3) nonprofits onchain via Endaoment's smart contracts.

## Quick Start

### Find a Charity

Search by name or EIN:
```bash
./scripts/search.sh "27-1661997"         # EIN lookup (GiveDirectly)
./scripts/search.sh "Red Cross"          # Name search
```

### Donate USDC (Base)

```bash
./scripts/donate.sh <ein> <amount_usdc>
```

Example: Donate $5 USDC to GiveDirectly:
```bash
./scripts/donate.sh 27-1661997 5
```

## How It Works

The donate script uses Bankr's arbitrary transaction feature to:
1. Approve USDC to the Endaoment OrgFundFactory
2. Call `deployOrgAndDonate(orgId, amount)` which:
   - Deploys the charity's entity contract on Base (if not already deployed)
   - Donates the specified USDC amount

## Popular Charities

| Charity | EIN |
|---------|-----|
| GiveDirectly | 27-1661997 |
| North Shore Animal League America | 11-1666852 |
| American Red Cross | 53-0196605 |
| Doctors Without Borders | 13-3433452 |
| ASPCA | 13-1623829 |

See `references/popular-charities.md` for more.

## Contract Addresses (Base)

| Contract | Address |
|----------|---------|
| Registry | `0x237b53bcfbd3a114b549dfec96a9856808f45c94` |
| OrgFundFactory | `0x10fd9348136dcea154f752fe0b6db45fc298a589` |
| USDC | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |

## Fees

- **Org donations**: 1.5% fee (e.g., $100 → $1.50 fee, $98.50 to charity)
- **Fund donations**: 0.05-0.50% tiered

## Requirements

- Bankr skill with API key configured
- USDC balance on Base
- ETH on Base for gas (Bankr covers this)

## Technical Details

### Function Selectors
- `approve(address,uint256)`: `0x095ea7b3`
- `deployOrgAndDonate(bytes32,uint256)`: `0xdb9e30cc`

### OrgId Encoding
The EIN (e.g., "11-1666852") is encoded as bytes32:
```
"11-1666852" → 0x31312d3136363638353200000000000000000000000000000000000000000000
```

## Notes

- All donations are tax-deductible (US 501(c)(3) orgs)
- Donations are permissionless — anyone can donate
- Uses Bankr arbitrary transactions for contract interaction
- Works on Base; other chains require different addresses
