---
name: onchainkit
description: Build onchain applications with React components and TypeScript utilities from Coinbase's OnchainKit. Use when users want to create crypto wallets, swap tokens, mint NFTs, build payments, display blockchain identities, or develop any onchain app functionality. Supports wallet connection, transaction building, token operations, identity management, and complete onchain app development workflows.
metadata: {"openclaw":{"emoji":"🔵","homepage":"https://onchainkit.xyz"}}
---

# OnchainKit

Build production-ready onchain applications using Coinbase's comprehensive React component library and TypeScript utilities.

## Overview

OnchainKit provides ready-to-use, full-stack components that abstract blockchain complexity, making it easy to build onchain applications without deep blockchain knowledge. It offers AI-friendly components that work automatically on Base, requires no backend infrastructure, and provides cost-effective transactions (< $0.01 fees).

## Quick Start

### New Project Setup
```bash
# Create a new onchain app with all batteries included
scripts/create-onchain-app.py <project-name>

# Verify setup
scripts/validate-setup.py
```

### Add to Existing Project
```bash
npm install @coinbase/onchainkit
# Setup configuration and providers
scripts/setup-environment.py
```

## Core Capabilities

### 1. Wallet Connection & Management
Connect users to their crypto wallets with minimal code:

```tsx
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';

function WalletConnection() {
  return (
    <Wallet>
      <ConnectWallet />
    </Wallet>
  );
}
```

**Use cases:**
- Wallet connection flows
- Display wallet status
- Manage connection state
- Handle multiple wallets

**Reference:** [references/wallet-integration.md](references/wallet-integration.md)

### 2. Identity Display
Show blockchain identities with ENS names, avatars, and verification badges:

```tsx
import { Identity, Avatar, Name, Badge } from '@coinbase/onchainkit/identity';

function UserProfile({ address }) {
  return (
    <Identity address={address}>
      <Avatar />
      <Name />
      <Badge />
    </Identity>
  );
}
```

**Reference:** [references/identity-components.md](references/identity-components.md)

### 3. Token Operations
Handle token swaps, purchases, and transfers:

```tsx
import { Swap, SwapAmountInput, SwapButton } from '@coinbase/onchainkit/swap';

function TokenSwap() {
  return (
    <Swap>
      <SwapAmountInput />
      <SwapButton />
    </Swap>
  );
}
```

**Supported operations:**
- Token swaps (any ERC-20)
- Token purchases with fiat
- Balance displays
- Price feeds

**Reference:** [references/token-operations.md](references/token-operations.md)

### 4. Transaction Building
Create and execute blockchain transactions:

```tsx
import { Transaction, TransactionButton } from '@coinbase/onchainkit/transaction';

function SendTransaction({ calls }) {
  return (
    <Transaction calls={calls}>
      <TransactionButton />
    </Transaction>
  );
}
```

**Reference:** [references/transactions.md](references/transactions.md)

### 5. Payment Processing
Build checkout flows and payment processing:

```tsx
import { Checkout, CheckoutButton } from '@coinbase/onchainkit/checkout';

function PaymentFlow() {
  return (
    <Checkout>
      <CheckoutButton />
    </Checkout>
  );
}
```

**Reference:** [references/payments.md](references/payments.md)

### 6. NFT Integration
Display, mint, and manage NFTs:

```tsx
import { NFTCard } from '@coinbase/onchainkit/nft';

function NFTDisplay({ contract, tokenId }) {
  return <NFTCard contract={contract} tokenId={tokenId} />;
}
```

**Reference:** [references/nft-integration.md](references/nft-integration.md)

## Common Workflows

### Setting Up a Complete App
1. **Initialize project** with `create-onchain-app.py`
2. **Configure providers** using setup templates
3. **Add wallet connection** with Wallet components
4. **Implement core features** (swap, buy, identity)
5. **Test and deploy** with validation scripts

### Building a Token Swap App
1. Start with swap app template from `assets/templates/swap-app/`
2. Configure token lists and supported chains
3. Add wallet connection flow
4. Implement swap interface
5. Add transaction confirmations

### Creating an NFT Marketplace
1. Use NFT template from `assets/templates/nft-mint/`
2. Set up NFT contract integration
3. Build minting interface
4. Add payment processing
5. Implement collection browsing

## Configuration & Setup

### Environment Variables
```bash
# Required for API access
NEXT_PUBLIC_CDP_API_KEY="your-api-key"
NEXT_PUBLIC_WC_PROJECT_ID="your-walletconnect-id"

# Optional configurations
NEXT_PUBLIC_CHAIN_ID="8453" # Base mainnet
```

**Reference:** [references/configuration.md](references/configuration.md)

### Provider Setup
OnchainKit requires proper React provider configuration:

```tsx
import { OnchainKitProvider } from '@coinbase/onchainkit';
import { WagmiProvider } from 'wagmi';

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <OnchainKitProvider
        apiKey={process.env.NEXT_PUBLIC_CDP_API_KEY}
        chain={base}
      >
        {/* Your app components */}
      </OnchainKitProvider>
    </WagmiProvider>
  );
}
```

## Component Patterns

### Progressive Enhancement
Start simple, add features as needed:

```tsx
// Basic wallet connection
<ConnectWallet />

// Enhanced with custom styling
<ConnectWallet className="custom-wallet-button" />

// Full wallet interface with status
<Wallet>
  <ConnectWallet />
  <WalletDropdown>
    <Identity />
    <WalletDropdownDisconnect />
  </WalletDropdown>
</Wallet>
```

### Composable Architecture
Mix and match components for custom workflows:

```tsx
function CustomApp() {
  return (
    <div>
      {/* User identity */}
      <Identity address={address}>
        <Avatar />
        <Name />
      </Identity>
      
      {/* Token operations */}
      <Swap>
        <SwapAmountInput />
        <SwapButton />
      </Swap>
      
      {/* Payment processing */}
      <Checkout>
        <CheckoutButton />
      </Checkout>
    </div>
  );
}
```

## Best Practices

### Performance
- Use component-level imports: `import { Wallet } from '@coinbase/onchainkit/wallet'`
- Implement proper loading states
- Cache API responses appropriately
- Optimize for mobile experiences

### Security
- Never expose private keys in client code
- Validate all transaction parameters
- Use official OnchainKit providers
- Implement proper error boundaries

### User Experience
- Provide clear transaction confirmations
- Show loading states during blockchain operations
- Handle wallet connection failures gracefully
- Support multiple wallet types

**Reference:** [references/best-practices.md](references/best-practices.md)

## Troubleshooting

### Common Issues
- **Wallet connection fails**: Check WalletConnect configuration
- **API errors**: Verify API key and network settings
- **Transaction reverts**: Validate contract calls and gas limits
- **Styling issues**: Import OnchainKit CSS properly

### Debug Steps
1. Check browser console for errors
2. Verify environment variables
3. Test with different wallets
4. Use validation script to check setup

**Reference:** [references/troubleshooting.md](references/troubleshooting.md)

## Templates & Examples

### Quick Start Templates
- **Basic App**: `assets/templates/basic-app/` - Minimal onchain app
- **Token Swap**: `assets/templates/swap-app/` - Complete swap interface  
- **NFT Minting**: `assets/templates/nft-mint/` - NFT marketplace
- **Commerce**: `assets/templates/commerce/` - Onchain store

### Real-World Examples
- Wallet connection with identity display
- Multi-token swap interface
- NFT collection with minting
- Payment processing with receipts

**Reference:** [references/examples.md](references/examples.md)

## Advanced Features

### Custom Chains
Support additional EVM chains beyond Base:

```tsx
const customChain = {
  id: 123456,
  name: 'Custom Chain',
  // ... chain configuration
};

<OnchainKitProvider chain={customChain}>
```

### MiniKit Integration
Build Farcaster Frame applications:

```tsx
import { useMiniKit } from '@coinbase/onchainkit/minikit';

function FrameApp() {
  const { isReady } = useMiniKit();
  return isReady ? <YourFrameContent /> : <Loading />;
}
```

**Reference:** [references/advanced-features.md](references/advanced-features.md)

## API Reference

OnchainKit provides both React components and utility functions:

- **Components**: Pre-built UI components for common onchain operations
- **Hooks**: React hooks for blockchain state management  
- **Utilities**: TypeScript utilities for data formatting and validation
- **Types**: Complete TypeScript definitions

**Reference:** [references/api-reference.md](references/api-reference.md)

## Resources

### Documentation
- Official docs: [onchainkit.xyz](https://onchainkit.xyz)
- GitHub: [github.com/coinbase/onchainkit](https://github.com/coinbase/onchainkit)
- Examples: [OnchainKit playground](https://github.com/coinbase/onchainkit/tree/main/packages/playground)

### Support
- Discord: [Coinbase Developer Platform](https://discord.gg/invite/cdp)
- Twitter: [@OnchainKit](https://x.com/OnchainKit)

---

**💡 Pro Tip**: Start with `npm create onchain` to bootstrap a working app, then customize components as needed. The quickstart template includes all necessary configuration and examples.

**🚀 Quick Win**: Use the validation script after setup to ensure everything is working correctly before building custom features.