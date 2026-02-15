# Security Considerations

## Architecture

This extension operates as a **read-only observer** of the Chia blockchain. It cannot sign transactions, spend coins, or access private keys.

## Network

- Connects to Chia full nodes via the official DNS introducer (`dns-introducer.chia.net`)
- Uses self-signed TLS certificates for peer authentication (standard Chia protocol)
- No outbound API calls to third-party services
- All data stays local (SQLite database on disk)

## Resource Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Max wallets | 50 | Prevent subscription flooding |
| Max DB rows | 100,000 | Prevent unbounded disk usage |
| Max regex length | 200 chars | Prevent ReDoS in memo handlers |
| Max memo handlers | 20 | Limit pattern matching overhead |
| Event queue max | 1,000 | Backpressure on peer events |

## Regex Safety

User-defined memo handler patterns are validated before compilation:
- Length limited to 200 characters
- Known ReDoS patterns (nested quantifiers) are rejected
- Patterns are pre-compiled at registration, not per-event

## Database Path

The database path is validated to ensure it resides within the OpenClaw data directory or `/tmp`. Path traversal attempts are rejected.

## Dependencies

- `chia-wallet-sdk` (0.29.0) — Official Chia wallet SDK for peer protocol
- `better-sqlite3` (11.7.0) — SQLite bindings for transaction storage

Both are pinned to exact versions. Verify integrity via `npm audit` before deployment.

## Opt-in Only

This extension is disabled by default (`config.enabled: false`). Users must explicitly configure wallet addresses and enable monitoring.

## Reporting

Report security issues to dev@koba42.com or open a GitHub issue.
