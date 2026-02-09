# Token Operations Reference

Complete guide for token swaps, purchases, and management with OnchainKit.

## Token Swaps

### Basic Swap Interface
```tsx
import {
  Swap,
  SwapAmountInput,
  SwapToggleButton,
  SwapButton,
  SwapMessage,
  SwapToast,
} from '@coinbase/onchainkit/swap';
import { Token } from '@coinbase/onchainkit/token';

const swappableTokens: Token[] = [
  {
    address: '', // ETH
    chainId: 8453,
    decimals: 18,
    name: 'Ethereum',
    symbol: 'ETH',
    image: 'https://wallet-api-production.s3.amazonaws.com/uploads/tokens/eth_288.png',
  },
  {
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    chainId: 8453,
    decimals: 6,
    name: 'USD Coin',
    symbol: 'USDC',
    image: 'https://d3r81g40ycuhqg.cloudfront.net/wallet/wais/44/2b/442b80bd16af0c0d9b22e03a16753823fe826e5bfd457292b55fa0ba8c1ba213-ZWUzYjJmZGUtMDYxNy00NDcyLTg0NjQtMWI4OGEwYjBiODE2',
  },
];

function TokenSwap() {
  return (
    <div className="w-full max-w-md">
      <Swap>
        <SwapAmountInput
          label="Sell"
          swappableTokens={swappableTokens}
          token={swappableTokens[0]}
          type="from"
        />
        <SwapToggleButton />
        <SwapAmountInput
          label="Buy"
          swappableTokens={swappableTokens}
          token={swappableTokens[1]}
          type="to"
        />
        <SwapButton />
        <SwapMessage />
        <SwapToast />
      </Swap>
    </div>
  );
}
```

### Custom Token Lists
```tsx
import { Token } from '@coinbase/onchainkit/token';

// Base ecosystem tokens
const baseTokens: Token[] = [
  {
    address: '',
    chainId: 8453,
    decimals: 18,
    name: 'Ethereum',
    symbol: 'ETH',
    image: 'https://wallet-api-production.s3.amazonaws.com/uploads/tokens/eth_288.png',
  },
  {
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    chainId: 8453,
    decimals: 6,
    name: 'USD Coin',
    symbol: 'USDC',
    image: '...',
  },
  {
    address: '0x4200000000000000000000000000000000000006',
    chainId: 8453,
    decimals: 18,
    name: 'Wrapped Ether',
    symbol: 'WETH',
    image: '...',
  },
  {
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    chainId: 8453,
    decimals: 18,
    name: 'Dai Stablecoin',
    symbol: 'DAI',
    image: '...',
  },
];

// Popular meme tokens
const memeTokens: Token[] = [
  {
    address: '0x6921d7a4c0c712b2b29ebf1c3f47e2bab17b87b7',
    chainId: 8453,
    decimals: 18,
    name: 'Based',
    symbol: 'BASED',
    image: '...',
  },
  // Add more meme tokens
];
```

### Swap with Custom Callbacks
```tsx
import { SwapError } from '@coinbase/onchainkit/swap';

function SwapWithCallbacks() {
  const handleSwapSuccess = (transactionReceipt) => {
    console.log('Swap successful!', transactionReceipt);
    // Track analytics, show success message, etc.
  };

  const handleSwapError = (error: SwapError) => {
    console.error('Swap failed:', error);
    // Show error message, track errors, etc.
  };

  return (
    <Swap
      onSuccess={handleSwapSuccess}
      onError={handleSwapError}
    >
      {/* Swap components */}
    </Swap>
  );
}
```

## Token Purchases

### Buy with Fiat
```tsx
import {
  Buy,
  BuyAmountInput,
  BuyButton,
  BuyMessage,
  BuyToast,
} from '@coinbase/onchainkit/buy';

function TokenPurchase() {
  return (
    <div className="w-full max-w-md">
      <Buy>
        <BuyAmountInput
          label="Buy"
          token={ethToken}
        />
        <BuyButton />
        <BuyMessage />
        <BuyToast />
      </Buy>
    </div>
  );
}
```

### Fund Wallet
```tsx
import {
  Fund,
  FundButton,
  FundToast,
} from '@coinbase/onchainkit/fund';

function WalletFunding() {
  return (
    <div className="w-full max-w-md">
      <Fund>
        <FundButton />
        <FundToast />
      </Fund>
    </div>
  );
}
```

## Token Display & Information

### Token Balance Display
```tsx
import { TokenBalance } from '@coinbase/onchainkit/token';
import { useAccount } from 'wagmi';

function UserBalance() {
  const { address } = useAccount();

  if (!address) return null;

  return (
    <div className="space-y-2">
      <TokenBalance
        address={address}
        token={{
          address: '',
          chainId: 8453,
          decimals: 18,
          symbol: 'ETH',
        }}
      />
      <TokenBalance
        address={address}
        token={{
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          chainId: 8453,
          decimals: 6,
          symbol: 'USDC',
        }}
      />
    </div>
  );
}
```

### Token Price Display
```tsx
import { TokenPrice } from '@coinbase/onchainkit/token';

function TokenPrices() {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="text-center">
        <p>ETH Price</p>
        <TokenPrice
          token={{
            address: '',
            chainId: 8453,
            decimals: 18,
            symbol: 'ETH',
          }}
        />
      </div>
      <div className="text-center">
        <p>USDC Price</p>
        <TokenPrice
          token={{
            address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            chainId: 8453,
            decimals: 6,
            symbol: 'USDC',
          }}
        />
      </div>
    </div>
  );
}
```

### Token Search
```tsx
import { TokenSearch } from '@coinbase/onchainkit/token';
import { useState } from 'react';

function TokenSelector() {
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);

  return (
    <div>
      <TokenSearch
        onSelect={setSelectedToken}
        tokens={swappableTokens}
      />
      {selectedToken && (
        <div className="mt-4">
          <p>Selected: {selectedToken.name} ({selectedToken.symbol})</p>
        </div>
      )}
    </div>
  );
}
```

## Advanced Token Operations

### Custom Slippage Settings
```tsx
import { Swap, SwapSettings } from '@coinbase/onchainkit/swap';

function SwapWithSettings() {
  return (
    <Swap
      config={{
        maxSlippage: 3, // 3% slippage tolerance
      }}
    >
      <SwapSettings />
      {/* Other swap components */}
    </Swap>
  );
}
```

### Multi-Token Swap
```tsx
function MultiTokenSwap() {
  const [fromToken, setFromToken] = useState(baseTokens[0]);
  const [toToken, setToToken] = useState(baseTokens[1]);

  return (
    <Swap>
      <SwapAmountInput
        label="From"
        swappableTokens={baseTokens}
        token={fromToken}
        type="from"
        onSelectToken={setFromToken}
      />
      <SwapToggleButton />
      <SwapAmountInput
        label="To"
        swappableTokens={baseTokens}
        token={toToken}
        type="to"
        onSelectToken={setToToken}
      />
      <SwapButton />
    </Swap>
  );
}
```

### Token Allowance Management
```tsx
import { useTokenAllowance, useApproveToken } from '@coinbase/onchainkit/token';

function TokenAllowance({ tokenAddress, spenderAddress }) {
  const { data: allowance } = useTokenAllowance({
    tokenAddress,
    spenderAddress,
  });

  const { approveToken, isLoading } = useApproveToken();

  const handleApprove = async () => {
    try {
      await approveToken({
        tokenAddress,
        spenderAddress,
        amount: parseUnits('1000', 18), // Approve 1000 tokens
      });
    } catch (error) {
      console.error('Approval failed:', error);
    }
  };

  return (
    <div>
      <p>Current allowance: {allowance?.toString()}</p>
      <button 
        onClick={handleApprove} 
        disabled={isLoading}
        className="bg-blue-500 text-white px-4 py-2 rounded"
      >
        {isLoading ? 'Approving...' : 'Approve Token'}
      </button>
    </div>
  );
}
```

## Error Handling

### Swap Error Types
```tsx
import { SwapError, SwapErrorType } from '@coinbase/onchainkit/swap';

function handleSwapError(error: SwapError) {
  switch (error.error) {
    case SwapErrorType.INSUFFICIENT_FUNDS:
      // Show insufficient funds message
      break;
    case SwapErrorType.SLIPPAGE_TOO_HIGH:
      // Suggest increasing slippage tolerance
      break;
    case SwapErrorType.NETWORK_ERROR:
      // Show network error and retry option
      break;
    case SwapErrorType.USER_REJECTED:
      // User cancelled transaction
      break;
    default:
      // Generic error handling
      break;
  }
}
```

### Token Validation
```tsx
function validateTokenAddress(address: string): boolean {
  // Check if it's a valid Ethereum address
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function validateTokenAmount(amount: string, decimals: number): boolean {
  try {
    const parsed = parseUnits(amount, decimals);
    return parsed > 0n;
  } catch {
    return false;
  }
}
```

## Performance Optimization

### Token List Caching
```tsx
import { useMemo } from 'react';
import { Token } from '@coinbase/onchainkit/token';

function useTokenList() {
  const tokens = useMemo(() => {
    // Cache expensive token list operations
    return baseTokens.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, []);

  return tokens;
}
```

### Debounced Token Search
```tsx
import { useDebounce } from 'use-debounce';
import { useState } from 'react';

function TokenSearchWithDebounce() {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm] = useDebounce(searchTerm, 300);

  const filteredTokens = useMemo(() => {
    return baseTokens.filter(token =>
      token.name.toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      token.symbol.toLowerCase().includes(debouncedSearchTerm.toLowerCase())
    );
  }, [debouncedSearchTerm]);

  return (
    <div>
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search tokens..."
      />
      {/* Render filtered tokens */}
    </div>
  );
}
```

## Best Practices

### 1. Always Validate User Input
```tsx
function ValidatedSwapInput() {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');

  const handleAmountChange = (value: string) => {
    if (!/^\d*\.?\d*$/.test(value)) {
      setError('Please enter a valid number');
      return;
    }
    
    setError('');
    setAmount(value);
  };

  return (
    <div>
      <input
        value={amount}
        onChange={(e) => handleAmountChange(e.target.value)}
      />
      {error && <p className="text-red-500">{error}</p>}
    </div>
  );
}
```

### 2. Handle Loading States
```tsx
function SwapWithLoading() {
  const [isLoading, setIsLoading] = useState(false);

  return (
    <Swap
      onStart={() => setIsLoading(true)}
      onSuccess={() => setIsLoading(false)}
      onError={() => setIsLoading(false)}
    >
      <SwapButton disabled={isLoading}>
        {isLoading ? 'Swapping...' : 'Swap'}
      </SwapButton>
    </Swap>
  );
}
```

### 3. Implement Proper Error Messages
```tsx
function UserFriendlyErrors({ error }: { error: SwapError }) {
  const getErrorMessage = (error: SwapError) => {
    switch (error.error) {
      case SwapErrorType.INSUFFICIENT_FUNDS:
        return "You don't have enough tokens for this swap.";
      case SwapErrorType.SLIPPAGE_TOO_HIGH:
        return "Price changed too much. Try again or increase slippage tolerance.";
      default:
        return "Something went wrong. Please try again.";
    }
  };

  return (
    <div className="bg-red-50 border border-red-200 rounded p-4">
      <p className="text-red-800">{getErrorMessage(error)}</p>
    </div>
  );
}
```

### 4. Gas Optimization
- Use multicall for multiple operations
- Batch token approvals when possible
- Consider gas prices in UI feedback
- Provide gas estimation before transactions

### 5. Security Best Practices
- Always validate token addresses
- Implement slippage protection
- Use secure RPC endpoints
- Validate transaction parameters
- Implement proper allowance management