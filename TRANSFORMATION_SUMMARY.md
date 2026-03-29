# FlashClaw Transformation Summary

## What Changed

This repository has been transformed from **OpenClaw** to **FlashClaw** - a specialized high-frequency DeFi arbitrage bot powered by Aave V5 flashloans.

## Key Features

- **100ms High-Frequency Scanning**: Scans DEX prices every 100 milliseconds for arbitrage opportunities
- **Aave V5 Flashloan Integration**: Executes zero-capital arbitrage using Aave V5 flashloans
- **Multi-DEX Support**: Monitors Uniswap V2, Sushiswap, and other DEXes simultaneously
- **Profit Optimization**: Calculates gas costs and only executes profitable trades

## Critical Configuration Required

Before running FlashClaw, you **MUST** configure these three critical fields in your `.env` file:

1. **PROFIT_WALLET_ADDRESS** - Where profits will be sent
2. **WALLET_SECRET_KEY** - Your private key for signing transactions (⚠️ KEEP SECURE!)
3. **AAVE_V5_POOL_ADDRESS** - The Aave V5 pool contract address for flashloans

## Quick Start

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Build the project:**
   ```bash
   pnpm build
   ```

3. **Configure your .env file:**
   - Fill in PROFIT_WALLET_ADDRESS
   - Fill in WALLET_SECRET_KEY
   - Fill in AAVE_V5_POOL_ADDRESS
   - Set your ETH_RPC_URL

4. **Start the bot:**
   ```bash
   flashclaw arbitrage start
   ```

## Files Changed

- `package.json` - Renamed to "flashclaw", updated description and repository URLs
- `.env` - NEW production configuration file with all required fields
- `src/commands/arbitrage.ts` - Reads configuration from environment variables
- `README.md` - Complete rebranding to FlashClaw
- `QUICKSTART.md` - Updated to reference .env configuration

## Architecture

The bot operates in a continuous loop:

1. **Scan** (every 100ms): Check prices across multiple DEXes
2. **Detect**: Find arbitrage opportunities where price differences exceed gas costs
3. **Execute**: Request Aave V5 flashloan → Buy low → Sell high → Repay loan → Keep profit
4. **Profit**: Send profits to your PROFIT_WALLET_ADDRESS

## Safety Features

- Minimum profit threshold (default: 0.01 ETH)
- Maximum gas price limits (default: 100 gwei)
- Single transaction execution to avoid conflicts
- Comprehensive validation and error handling

## Documentation

- `README.md` - Full project overview
- `QUICKSTART.md` - Step-by-step setup guide
- `FLASHLOAN_ARBITRAGE.md` - Technical deep dive
- `.env` - Configuration template with detailed comments

## Command Reference

```bash
flashclaw arbitrage start   # Start the arbitrage bot
flashclaw arbitrage status  # View bot statistics
flashclaw arbitrage config  # Show current configuration
```

## Security Warning

⚠️ **NEVER commit your .env file to git!** It contains your private key.

The `.env` file is already in `.gitignore` to prevent accidental commits.

## Testing

Test on a testnet first:

```bash
# Update .env with testnet values
ETH_RPC_URL=https://eth-goerli.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=5
AAVE_V5_POOL_ADDRESS=0xTestnetPoolAddress

# Run tests
pnpm test -- src/defi/
```

## Support

- GitHub Issues: https://github.com/cosmic-hydra/flashclaw/issues
- Documentation: See QUICKSTART.md and FLASHLOAN_ARBITRAGE.md

## Disclaimer

⚠️ **Use at your own risk!** Cryptocurrency trading involves substantial risk of loss. This is educational software - thoroughly test before using real funds.
