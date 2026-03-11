# Contributing to Agent Commerce

Thank you for your interest in contributing! 🎉

## Development Setup

```bash
# Clone the repo
git clone https://github.com/lluviaoscuradeldoce-design/agent-commerce.git
cd agent-commerce

# Install dependencies
pnpm install
```

## Local Hardhat Instructions

The easiest way to test `agent-commerce` without pending real gas is using the local Hardhat network included with this extension.

### 1. Start the Local Network

In a separate terminal, run the local Hardhat node. This will give you 20 pre-funded test accounts with 10,000 fake ETH:

```bash
cd extensions/agent-commerce
npx hardhat node
```

### 2. Deploy the ClawToken Contract

With the node running, deploy the ERC20 token to the local network:

```bash
cd extensions/agent-commerce
npx hardhat run scripts/deploy.ts --network localhost
```

This script will output the deployed `Contract Address`.

### 3. Update `moltbot.json`

Update your `~/.clawdbot/moltbot.json` to configure the extension with the local credentials:

```json
"agent-commerce": {
    "enabled": true,
    "rpcUrl": "http://127.0.0.1:8545",
    "contractAddress": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "chainId": 31337,
    "privateKey": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
}
```

_(The private key above is Account #0 provided by Hardhat)._

## Running Tests

```bash
pnpm test
```

## Type-check

```bash
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
