---
name: solana-verify-build
description: Enforce verifiable and deterministic builds for Solana programs to guarantee that the on-chain executable matches the deployed source code.
---

# SKILL: SOLANA VERIFIABLE BUILD (DETERMINISTIC DEPLOYMENT)

A mandatory skill ensuring trust, transparency, and security by guaranteeing that deployed Solana programs perfectly match their public source code.

## THE VERIFIABLE BUILD MANDATE

- **No Local Ambient Builds**: Never build a program for production deployment using your local environment (`anchor build`). You MUST use a deterministic environment (Docker) to ensure the hash of the built executable is perfectly reproducible.

## VERIFIABLE BUILD PROCESS

### 1. Pre-Flight Checks

Before initiating a verifiable build, you MUST:

- Run `cargo audit` to check for crates with known security vulnerabilities.
- Run `cargo machete` to find and remove unused dependencies.
- Ensure all changes are committed and pushed to the public Git repository.

### 2. Building the Program deterministically

Use the appropriate tool depending on the framework:

**For Anchor framework:**

```bash
anchor build --verifiable
```

**For Vanilla/Native Solana (using solana-verify CLI):**

```bash
solana-verify build
```

*Note: Both processes use Docker under the hood to compile the program in a standard environment.*

### 3. On-Chain Verification

After deploying the deterministically built `.so` file to the Solana network, the deployed code must be verified against the source repository.

**For Anchor framework:**

```bash
# This creates/updates a Verification PDA on-chain
anchor verify <PROGRAM_ID>
```

**For Vanilla/Native Solana:**

```bash
solana-verify verify-from-repo -u <GIT_URL> -c <COMMIT_HASH> -p <PROGRAM_ID>
```

## THE VERIFICATION PDA

During the verification step, a Program Derived Address (PDA) is created or updated on-chain. This PDA acts as a public registry entry, storing:

- The Program ID
- The Git Repository URL
- The Git Commit Hash
- The build arguments used

This allows anyone to trustlessly verify the program from the provided source code, often visible via a "Verified" badge on explorers like SolanaFM or Solana Explorer.

## CI/CD INTEGRATION

Verifiable builds should be integrated into standard deployment pipelines (e.g., GitHub Actions). The CI pipeline should reproduce the build using `solana-verify` and assert that the generated hash matches the hash of the program being proposed for deployment.

## GEMINI THINKING PROTOCOL

> [!IMPORTANT]
> When executing a deployment or build task, use `<think>` to:
>
> 1. Confirm all security pre-checks (`cargo audit`, `cargo machete`) have passed.
> 2. Verify the Git working tree is clean and the current commit is pushed to the remote.
> 3. Ensure the correct command (`--verifiable`) is used to invoke the Dockerized build environment.
