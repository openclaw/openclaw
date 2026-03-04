# Contributing to Agent Commerce

Thank you for your interest in contributing! 🎉

## Development Setup

```bash
# Clone the repo
git clone https://github.com/lluviaoscuradeldoce-design/agent-commerce.git
cd agent-commerce

# Install dependencies
pnpm install

# Run tests
pnpm test

# Type-check
pnpm build
```

## Code Style

- TypeScript strict mode (`strict: true`)
- ES2022 target with Node16 module resolution
- Use `const` assertions where possible
- Explicit return types on exported functions

## Pull Request Process

1. Fork the repository and create a feature branch (`feat/my-feature`).
2. Write tests for any new functionality.
3. Ensure all tests pass (`pnpm test`).
4. Ensure type-checking passes (`pnpm build`).
5. Update `CHANGELOG.md` under `## [Unreleased]`.
6. Open a Pull Request with a clear description.

## Smart Contract Changes

If modifying `contracts/ClawToken.sol`:

1. Update the ABI in `src/contract-abi.ts`.
2. Write corresponding Hardhat/Foundry tests.
3. Test on Base Sepolia testnet before mainnet.

## Reporting Issues

- Use GitHub Issues for bugs and feature requests.
- Include reproduction steps and environment details.
- For security vulnerabilities, email directly (do not open a public issue).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
