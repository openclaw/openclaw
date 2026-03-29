# FlashClaw - Aave Flashloan Arbitrage Bot

FlashClaw is an OpenClaw-powered Aave flashloan arbitrage bot that actively searches for arbitrage opportunities across multiple DEXes and executes profitable trades every 100 milliseconds.

## Features

- 🔄 **High-Frequency Scanning**: Monitors DEX prices every 100ms
- ⚡ **Aave Flashloans**: Executes arbitrage using Aave V3 flashloans
- 💰 **Multi-DEX Support**: Scans Uniswap V2, Sushiswap, and other DEXes
- 📊 **Profit Tracking**: Comprehensive statistics and reporting
- 🛡️ **Safety Controls**: Configurable profit thresholds and gas limits

## Architecture

### Core Components

1. **PriceScanner** (`src/defi/price-scanner.ts`)
   - Fetches real-time prices from multiple DEXes
   - Identifies arbitrage opportunities
   - Calculates expected profits after gas costs

2. **FlashloanExecutor** (`src/defi/flashloan-executor.ts`)
   - Executes Aave V3 flashloans
   - Performs multi-hop arbitrage trades
   - Handles transaction submission and monitoring

3. **ArbitrageBot** (`src/defi/arbitrage-bot.ts`)
   - Main orchestration loop
   - Manages 100ms scan intervals
   - Tracks performance statistics

## Configuration

### Environment Variables

```bash
# Blockchain RPC
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Wallet (KEEP SECURE!)
PRIVATE_KEY=your_private_key_here

# Optional: Gas settings
MAX_GAS_PRICE=100000000000  # 100 gwei
GAS_LIMIT=500000

# Profit threshold (in wei)
MIN_PROFIT=100000000000000000  # 0.1 ETH
```

### Configuration Object

The bot uses an `ArbitrageConfig` object with the following structure:

```typescript
{
  enabled: true,
  scanInterval: 100,  // milliseconds
  minProfitThreshold: BigInt(10 ** 17),  // 0.1 ETH
  maxGasPrice: BigInt(100) * BigInt(10 ** 9),  // 100 gwei
  blockchain: {
    rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/...",
    chainId: 1,
    privateKey: "0x...",
  },
  aave: {
    poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    // ... more Aave addresses
  },
  dexes: [
    { name: "Uniswap V2", router: "0x...", factory: "0x..." },
    { name: "Sushiswap", router: "0x...", factory: "0x..." },
  ]
}
```

## Usage

### Start the Arbitrage Bot

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Start the bot
openclaw arbitrage start
```

### Check Status

```bash
# View current statistics
openclaw arbitrage status
```

### View Configuration

```bash
# Display current configuration
openclaw arbitrage config
```

## How It Works

### 1. Price Monitoring (100ms intervals)

The bot continuously scans configured DEXes for token prices:

```
Every 100ms:
├─ Fetch prices from Uniswap V2
├─ Fetch prices from Sushiswap
├─ Fetch prices from other DEXes
└─ Compare prices for arbitrage opportunities
```

### 2. Opportunity Detection

When price differences are found:

```
Price Analysis:
├─ Calculate buy price (cheapest DEX)
├─ Calculate sell price (most expensive DEX)
├─ Estimate gas costs
├─ Compute net profit after fees
└─ Filter by minimum profit threshold
```

### 3. Flashloan Execution

For profitable opportunities:

```
Flashloan Flow:
1. Request flashloan from Aave Pool
2. Receive loaned tokens
3. Buy tokens on DEX A (cheaper)
4. Sell tokens on DEX B (expensive)
5. Repay flashloan + fee
6. Keep the profit
```

### 4. Transaction Flow

```solidity
// Simplified smart contract logic
function executeArbitrage(
  address[] calldata path,
  uint256 amount
) external {
  // 1. Get flashloan from Aave
  pool.flashLoanSimple(address(this), asset, amount, params, 0);
}

function executeOperation(
  address asset,
  uint256 amount,
  uint256 premium,
  address initiator,
  bytes calldata params
) external returns (bool) {
  // 2. Decode arbitrage path
  // 3. Execute swaps
  // 4. Approve repayment
  // 5. Return true for success
}
```

## Token Pairs Monitored

The bot monitors these common pairs by default:

- WETH / USDC
- WETH / USDT
- WETH / DAI

Additional pairs can be configured in the bot initialization.

## Safety Features

### Profit Threshold

- Only executes trades above minimum profit threshold
- Accounts for gas costs in profitability calculation
- Prevents loss-making trades

### Gas Protection

- Maximum gas price limit
- Gas estimation before execution
- Transaction failure handling

### Execution Controls

- Single transaction at a time (prevents race conditions)
- Opportunity validation before execution
- Automatic price data refresh

## Statistics Tracking

The bot tracks comprehensive statistics:

```typescript
{
  totalOpportunities: 142,      // Total opportunities found
  executedTrades: 23,            // Trades attempted
  successfulTrades: 19,          // Successful executions
  failedTrades: 4,               // Failed transactions
  totalProfit: 5200000000000000000n,  // 5.2 ETH total profit
  totalLoss: 300000000000000000n,     // 0.3 ETH total loss
  netProfit: 4900000000000000000n,    // 4.9 ETH net profit
  lastScanTime: 1711724234567,   // Last scan timestamp
  lastExecutionTime: 1711724230000  // Last execution timestamp
}
```

## Development

### Project Structure

```
src/defi/
├── types.ts              # Type definitions
├── price-scanner.ts      # DEX price scanning
├── flashloan-executor.ts # Flashloan execution
├── arbitrage-bot.ts      # Main bot orchestration
└── index.ts              # Module exports

src/commands/
└── arbitrage.ts          # CLI command interface
```

### Adding New DEXes

To add support for additional DEXes, update the configuration:

```typescript
dexes: [
  {
    name: "Your DEX Name",
    router: "0x...",
    factory: "0x...",
    fee: 3000,  // fee in basis points
  }
]
```

### Testing

```bash
# Run tests
pnpm test

# Run with test RPC
ETH_RPC_URL=http://localhost:8545 openclaw arbitrage start
```

## Important Notes

### ⚠️ Security Warnings

1. **Private Key Security**: Never commit private keys to git. Use environment variables or secure key management.

2. **RPC Reliability**: Use reliable RPC providers (Alchemy, Infura) for consistent performance.

3. **Gas Costs**: Monitor gas prices carefully. High gas can eliminate profits.

4. **Slippage**: Large trades may experience slippage, reducing actual profits.

5. **MEV**: Other bots may front-run transactions. Consider using Flashbots or private pools.

### 💡 Optimization Tips

1. **RPC Speed**: Use low-latency RPC endpoints
2. **Mempool Monitoring**: Consider monitoring mempool for better opportunities
3. **Multi-Chain**: Extend to other EVM chains (Polygon, Arbitrum, etc.)
4. **Custom Routers**: Deploy custom router contracts for lower gas costs
5. **Flashbots**: Use Flashbots to avoid MEV attacks

## Disclaimer

This bot is for educational purposes. Cryptocurrency trading involves substantial risk of loss. Use at your own risk. Always test thoroughly on testnets before using real funds.

## License

MIT License - see LICENSE file for details

## Contributing

Contributions welcome! Please open issues and pull requests on GitHub.

## Support

For questions and support:
- GitHub Issues: https://github.com/cosmic-hydra/flashclaw/issues
- OpenClaw Discord: https://discord.gg/clawd
