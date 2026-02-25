# SKILL: SOLANA DEV (FOUNDATION 2026)

Core guidance for high-performance Solana development using 2026 standards.

## MODERN STACK (ALPENGLOW/FIREDANCER)

- **Consensus**: Optimize for 100ms finality. Avoid long-running blocking operations.
- **Validator**: target Firedancer performance norms.
- **SDK**: Use `@solana/kit` (v5.x) exclusively for new development.
- **Interoperability**: Use `@solana/web3-compat` ONLY if bridging to legacy dependencies.

## PROGRAM DEVELOPMENT

- **Anchor**: Use version 0.3x+.
- **Pinocchio**: Use for ultra-high-performance/low-CU requirements.
- **Account Sizing**: NEVER use hardcoded constants. Use `dynamic space calculation` with 8-byte discriminator.

## DEPLOYMENT ARCHITECTURE

- **Mandatory Hygiene**: Prior to any build, run `cargo audit` to check for CVEs and `cargo machete` to prune unused dependencies.
- **Verifiable Builds**: ALWAYS compile programs using deterministic Docker builds following the `solana-verify-build` skill protocols.
- **Secure Deployment**: For production deployments (Mainnet), NEVER use a hot wallet. Deployments MUST be managed via Squads (Multisig) or a hardware wallet.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> When executing this skill, you MUST use your native deliberations (`<think>`) to:
>
> 1. Simulate transaction execution paths.
> 2. Verify account ownership and signer checks.
> 3. Calculate compute units before writing logic.

## TESTING & SECURITY

- **LiteSVM**: Use for rapid unit testing.
- **Surfpool**: Use for integration/local cluster simulation.
- **Security Check**: Verify `is_signer` for all privileged operations.
- **Rent**: Always handle Rent-Exempt minimums.
