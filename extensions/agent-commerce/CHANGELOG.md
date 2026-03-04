# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-02-13

### Added

- **Smart Contract**: `ClawToken.sol` — ERC-20 with integrated escrow (lock/release/refund).
- **Wallet Manager**: Create/import keypairs, query CLAW + ETH balances, approve & transfer tokens.
- **Marketplace Registry**: Publish, search, update, and remove agent service listings with category filtering.
- **Escrow Manager**: Full trade lifecycle — initiate → lock (on-chain) → deliver → release/refund.
- **HTTP API**: 15 REST endpoints under `/commerce/*` for wallet, marketplace, and trade operations.
- **Plugin Entry Point**: OpenClaw plugin following the official extension pattern (`openclaw.plugin.json` + `index.ts`).
- **Tests**: Unit tests for marketplace (6), wallet (4), and escrow (4) using Vitest.
- **Documentation**: README with architecture diagrams, API reference, and setup instructions.
