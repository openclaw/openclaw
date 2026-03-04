# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not** open a public GitHub issue.

Instead, please report it responsibly by emailing the maintainer directly. Include:

1. A description of the vulnerability.
2. Steps to reproduce.
3. Potential impact and severity assessment.

We will acknowledge receipt within **48 hours** and aim to provide a fix within **7 days** for critical issues.

## Security Considerations

### Smart Contract

- The `ClawToken.sol` contract should be **audited** before mainnet deployment.
- Escrow timeout is configurable; a very short timeout may result in premature refunds.
- Only the contract owner can resolve disputes via `refundEscrow()`.

### Wallet Storage

- Private keys are stored in plaintext at `~/.openclaw/agent-commerce/wallet.json`.
- **Never** share or commit this file.
- Future versions will support encrypted key storage and hardware wallets.

### API Access

- The commerce HTTP API inherits OpenClaw Gateway's authentication (token-based).
- All trade operations require a valid wallet to sign on-chain transactions.
