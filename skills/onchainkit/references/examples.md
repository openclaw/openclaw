# OnchainKit Examples

Real-world implementation examples and common use cases.

## Complete App Examples

### 1. DeFi Portfolio Tracker
A comprehensive app that tracks user's DeFi positions and allows token swaps.

```tsx
// pages/portfolio.tsx
import { useAccount, useBalance } from 'wagmi';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { Identity, Avatar, Name } from '@coinbase/onchainkit/identity';
import { Swap } from '@coinbase/onchainkit/swap';

function PortfolioPage() {
  const { address, isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">DeFi Portfolio Tracker</h1>
          <p className="text-gray-600 mb-6">Connect your wallet to get started</p>
          <Wallet>
            <ConnectWallet />
          </Wallet>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Portfolio</h1>
          <Wallet>
            <ConnectWallet>
              <Avatar className="h-6 w-6" />
              <Name />
            </ConnectWallet>
          </Wallet>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <PortfolioOverview address={address} />
            <TokenBalances address={address} />
          </div>
          <div>
            <SwapInterface />
          </div>
        </div>
      </main>
    </div>
  );
}

function PortfolioOverview({ address }) {
  const { data: ethBalance } = useBalance({ address });
  const { data: usdcBalance } = useBalance({
    address,
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  });

  const totalValue = calculateTotalValue(ethBalance, usdcBalance);

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold mb-4">Portfolio Overview</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-sm text-gray-500">Total Value</p>
          <p className="text-2xl font-bold">${totalValue.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Assets</p>
          <p className="text-2xl font-bold">2</p>
        </div>
      </div>
    </div>
  );
}

function SwapInterface() {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Quick Swap</h2>
      <Swap>
        {/* Swap components */}
      </Swap>
    </div>
  );
}
```

### 2. NFT Marketplace
An NFT marketplace with minting and trading capabilities.

```tsx
// pages/marketplace.tsx
import { useState } from 'react';
import { NFTCard } from '@coinbase/onchainkit/nft';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { Transaction, TransactionButton } from '@coinbase/onchainkit/transaction';

interface NFT {
  contract: `0x${string}`;
  tokenId: string;
  name: string;
  image: string;
  price?: string;
}

function MarketplacePage() {
  const [selectedNFT, setSelectedNFT] = useState<NFT | null>(null);
  const [nfts, setNfts] = useState<NFT[]>([
    // Sample NFTs
    {
      contract: '0x...',
      tokenId: '1',
      name: 'Cool NFT #1',
      image: '/nft1.png',
      price: '0.1',
    },
    // ... more NFTs
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">NFT Marketplace</h1>
          <Wallet>
            <ConnectWallet />
          </Wallet>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {nfts.map((nft, index) => (
            <NFTCard
              key={`${nft.contract}-${nft.tokenId}`}
              contract={nft.contract}
              tokenId={nft.tokenId}
              onClick={() => setSelectedNFT(nft)}
            />
          ))}
        </div>

        {selectedNFT && (
          <NFTModal
            nft={selectedNFT}
            onClose={() => setSelectedNFT(null)}
          />
        )}
      </main>
    </div>
  );
}

function NFTModal({ nft, onClose }: { nft: NFT; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">{nft.name}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ×
          </button>
        </div>

        <NFTCard contract={nft.contract} tokenId={nft.tokenId} />

        {nft.price && (
          <div className="mt-4">
            <p className="text-lg font-semibold mb-2">Price: {nft.price} ETH</p>
            <Transaction
              calls={[{
                to: nft.contract,
                data: '0x...', // Purchase function call
                value: parseEther(nft.price),
              }]}
            >
              <TransactionButton text={`Buy for ${nft.price} ETH`} />
            </Transaction>
          </div>
        )}
      </div>
    </div>
  );
}
```

### 3. Token Launchpad
A platform for launching and trading new tokens.

```tsx
// pages/launchpad.tsx
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { Transaction, TransactionButton } from '@coinbase/onchainkit/transaction';
import { Buy } from '@coinbase/onchainkit/buy';

function LaunchpadPage() {
  const { isConnected } = useAccount();
  const [newTokens, setNewTokens] = useState([
    {
      address: '0x...',
      name: 'NewToken',
      symbol: 'NEW',
      description: 'An innovative new token',
      totalSupply: '1000000',
      price: '0.001',
    },
    // ... more tokens
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Token Launchpad</h1>
          <div className="flex gap-4">
            <button className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
              Launch Token
            </button>
            <Wallet>
              <ConnectWallet />
            </Wallet>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-4">Featured Launches</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {newTokens.map((token, index) => (
              <TokenCard key={token.address} token={token} />
            ))}
          </div>
        </div>

        {isConnected && <LaunchTokenForm />}
      </main>
    </div>
  );
}

function TokenCard({ token }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-2">{token.name} ({token.symbol})</h3>
      <p className="text-gray-600 mb-4">{token.description}</p>
      <div className="grid grid-cols-2 gap-4 text-sm text-gray-500 mb-4">
        <div>
          <p>Total Supply</p>
          <p className="font-semibold">{token.totalSupply}</p>
        </div>
        <div>
          <p>Price</p>
          <p className="font-semibold">{token.price} ETH</p>
        </div>
      </div>
      <Buy>
        <BuyAmountInput token={token} />
        <BuyButton />
      </Buy>
    </div>
  );
}
```

## Component Integration Examples

### 1. Multi-Step Onboarding Flow
```tsx
import { useState } from 'react';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { Identity, Avatar, Name } from '@coinbase/onchainkit/identity';
import { Fund } from '@coinbase/onchainkit/fund';

function OnboardingFlow() {
  const [step, setStep] = useState(1);
  const { isConnected } = useAccount();

  const steps = [
    { title: 'Connect Wallet', component: <WalletStep /> },
    { title: 'Fund Account', component: <FundingStep /> },
    { title: 'Complete Setup', component: <CompletionStep /> },
  ];

  return (
    <div className="max-w-md mx-auto">
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          {steps.map((_, index) => (
            <div
              key={index}
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                index + 1 <= step 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-gray-200 text-gray-500'
              }`}
            >
              {index + 1}
            </div>
          ))}
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className="bg-blue-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${(step / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-bold mb-4">{steps[step - 1].title}</h2>
        {steps[step - 1].component}
      </div>
    </div>
  );
}

function WalletStep() {
  return (
    <div className="text-center">
      <p className="text-gray-600 mb-6">Connect your wallet to get started</p>
      <Wallet>
        <ConnectWallet />
      </Wallet>
    </div>
  );
}

function FundingStep() {
  return (
    <div>
      <p className="text-gray-600 mb-6">Add funds to your wallet to start trading</p>
      <Fund>
        <FundButton />
      </Fund>
    </div>
  );
}
```

### 2. Advanced Swap Interface with Settings
```tsx
import { useState } from 'react';
import {
  Swap,
  SwapAmountInput,
  SwapToggleButton,
  SwapButton,
  SwapSettings,
  SwapMessage,
} from '@coinbase/onchainkit/swap';

function AdvancedSwapInterface() {
  const [showSettings, setShowSettings] = useState(false);
  const [slippage, setSlippage] = useState(0.5);
  const [deadline, setDeadline] = useState(20);

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-md mx-auto">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Swap Tokens</h2>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="text-gray-500 hover:text-gray-700"
        >
          ⚙️
        </button>
      </div>

      {showSettings && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg">
          <div className="mb-3">
            <label className="block text-sm font-medium mb-1">
              Slippage Tolerance
            </label>
            <div className="flex gap-2">
              {[0.1, 0.5, 1.0].map((value) => (
                <button
                  key={value}
                  onClick={() => setSlippage(value)}
                  className={`px-3 py-1 rounded ${
                    slippage === value
                      ? 'bg-blue-500 text-white'
                      : 'bg-white border'
                  }`}
                >
                  {value}%
                </button>
              ))}
              <input
                type="number"
                value={slippage}
                onChange={(e) => setSlippage(Number(e.target.value))}
                className="w-16 px-2 py-1 border rounded text-center"
                step="0.1"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Transaction Deadline
            </label>
            <input
              type="number"
              value={deadline}
              onChange={(e) => setDeadline(Number(e.target.value))}
              className="w-20 px-2 py-1 border rounded"
            />
            <span className="ml-2 text-sm text-gray-500">minutes</span>
          </div>
        </div>
      )}

      <Swap
        config={{
          maxSlippage: slippage,
          transactionDeadlineMinutes: deadline,
        }}
      >
        <SwapAmountInput
          label="From"
          swappableTokens={swappableTokens}
          token={swappableTokens[0]}
          type="from"
        />
        <SwapToggleButton />
        <SwapAmountInput
          label="To"
          swappableTokens={swappableTokens}
          token={swappableTokens[1]}
          type="to"
        />
        <SwapButton />
        <SwapMessage />
      </Swap>
    </div>
  );
}
```

### 3. Social Trading Dashboard
```tsx
import { useAccount } from 'wagmi';
import { Identity, Avatar, Name, Badge } from '@coinbase/onchainkit/identity';
import { Swap } from '@coinbase/onchainkit/swap';

interface Trader {
  address: `0x${string}`;
  followers: number;
  roi: number;
  recentTrade: {
    from: string;
    to: string;
    amount: string;
    timestamp: Date;
  };
}

function SocialTradingDashboard() {
  const [topTraders, setTopTraders] = useState<Trader[]>([
    {
      address: '0x...',
      followers: 1250,
      roi: 45.2,
      recentTrade: {
        from: 'ETH',
        to: 'USDC',
        amount: '2.5',
        timestamp: new Date(),
      },
    },
    // ... more traders
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <h2 className="text-xl font-bold mb-4">Top Traders</h2>
            <div className="space-y-4">
              {topTraders.map((trader, index) => (
                <TraderCard key={trader.address} trader={trader} rank={index + 1} />
              ))}
            </div>
          </div>
          <div>
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold mb-4">Quick Trade</h3>
              <Swap>
                {/* Swap interface */}
              </Swap>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TraderCard({ trader, rank }: { trader: Trader; rank: number }) {
  const [isFollowing, setIsFollowing] = useState(false);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-gray-300">#{rank}</span>
          <Identity address={trader.address}>
            <Avatar className="h-10 w-10" />
            <div>
              <Name className="font-medium" />
              <Badge />
            </div>
          </Identity>
        </div>
        <button
          onClick={() => setIsFollowing(!isFollowing)}
          className={`px-4 py-2 rounded-full text-sm font-medium ${
            isFollowing
              ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
        >
          {isFollowing ? 'Following' : 'Follow'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 text-center mb-4">
        <div>
          <p className="text-sm text-gray-500">Followers</p>
          <p className="font-bold">{trader.followers}</p>
        </div>
        <div>
          <p className="text-sm text-gray-500">ROI</p>
          <p className={`font-bold ${trader.roi > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {trader.roi > 0 ? '+' : ''}{trader.roi}%
          </p>
        </div>
        <div>
          <p className="text-sm text-gray-500">Trades</p>
          <p className="font-bold">247</p>
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="text-sm text-gray-500 mb-2">Recent Trade</p>
        <div className="flex items-center justify-between">
          <span className="text-sm">
            {trader.recentTrade.amount} {trader.recentTrade.from} → {trader.recentTrade.to}
          </span>
          <span className="text-xs text-gray-500">
            {trader.recentTrade.timestamp.toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}
```

## Utility and Helper Examples

### 1. Token Price Tracking
```tsx
import { useQuery } from '@tanstack/react-query';
import { Token } from '@coinbase/onchainkit/token';

function useTokenPrice(token: Token) {
  return useQuery({
    queryKey: ['tokenPrice', token.address],
    queryFn: async () => {
      const response = await fetch(`/api/price/${token.address}`);
      return response.json();
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });
}

function TokenPriceTracker({ tokens }: { tokens: Token[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {tokens.map((token) => (
        <TokenPriceCard key={token.address} token={token} />
      ))}
    </div>
  );
}

function TokenPriceCard({ token }: { token: Token }) {
  const { data: price, isLoading } = useTokenPrice(token);
  const [priceHistory, setPriceHistory] = useState([]);

  useEffect(() => {
    if (price) {
      setPriceHistory(prev => [...prev.slice(-23), price]);
    }
  }, [price]);

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="flex items-center gap-2 mb-2">
        <img src={token.image} alt={token.symbol} className="w-6 h-6 rounded-full" />
        <span className="font-medium">{token.symbol}</span>
      </div>
      
      {isLoading ? (
        <div className="animate-pulse bg-gray-200 h-6 rounded"></div>
      ) : (
        <>
          <p className="text-2xl font-bold">${price?.current}</p>
          <p className={`text-sm ${price?.change24h > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {price?.change24h > 0 ? '+' : ''}{price?.change24h}%
          </p>
          <div className="mt-2 h-16 bg-gray-50 rounded">
            <MiniChart data={priceHistory} />
          </div>
        </>
      )}
    </div>
  );
}
```

### 2. Transaction History
```tsx
import { useAccount } from 'wagmi';
import { Identity, Avatar, Name } from '@coinbase/onchainkit/identity';

function TransactionHistory() {
  const { address } = useAccount();
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    if (address) {
      fetchTransactionHistory(address).then(setTransactions);
    }
  }, [address]);

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-6 border-b">
        <h2 className="text-lg font-semibold">Recent Transactions</h2>
      </div>
      
      <div className="divide-y">
        {transactions.map((tx, index) => (
          <TransactionItem key={tx.hash} transaction={tx} />
        ))}
      </div>
    </div>
  );
}

function TransactionItem({ transaction }) {
  const getTransactionIcon = (type) => {
    switch (type) {
      case 'swap': return '🔄';
      case 'send': return '↗️';
      case 'receive': return '↘️';
      case 'approve': return '✅';
      default: return '📋';
    }
  };

  return (
    <div className="p-4 hover:bg-gray-50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{getTransactionIcon(transaction.type)}</span>
          <div>
            <p className="font-medium capitalize">{transaction.type}</p>
            <p className="text-sm text-gray-500">
              {new Date(transaction.timestamp).toLocaleString()}
            </p>
          </div>
        </div>
        
        <div className="text-right">
          <p className="font-medium">{transaction.value} {transaction.symbol}</p>
          <a
            href={`https://basescan.org/tx/${transaction.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-500 hover:underline"
          >
            View on Explorer ↗
          </a>
        </div>
      </div>
    </div>
  );
}
```

These examples show real-world implementations that users can adapt for their specific needs, demonstrating best practices for component composition, state management, and user experience.