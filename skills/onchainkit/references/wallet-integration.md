# Wallet Integration Reference

Complete guide for implementing wallet connection and management with OnchainKit.

## Basic Wallet Connection

### Simple Connection
```tsx
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';

function App() {
  return (
    <Wallet>
      <ConnectWallet />
    </Wallet>
  );
}
```

### With Identity Display
```tsx
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { Avatar, Name } from '@coinbase/onchainkit/identity';

function App() {
  return (
    <Wallet>
      <ConnectWallet>
        <Avatar className="h-6 w-6" />
        <Name />
      </ConnectWallet>
    </Wallet>
  );
}
```

## Full Wallet Interface

### Complete Dropdown Menu
```tsx
import { 
  Wallet,
  ConnectWallet,
  WalletDropdown,
  WalletDropdownBasename,
  WalletDropdownDisconnect,
  WalletDropdownFundLink,
  WalletDropdownLink,
} from '@coinbase/onchainkit/wallet';
import { Avatar, Name, Identity } from '@coinbase/onchainkit/identity';

function WalletInterface() {
  return (
    <Wallet>
      <ConnectWallet>
        <Avatar className="h-6 w-6" />
        <Name />
      </ConnectWallet>
      <WalletDropdown>
        <Identity className="px-4 pt-3 pb-2">
          <Avatar />
          <Name />
        </Identity>
        <WalletDropdownBasename />
        <WalletDropdownLink icon="wallet" href="https://keys.coinbase.com">
          Wallet
        </WalletDropdownLink>
        <WalletDropdownFundLink />
        <WalletDropdownDisconnect />
      </WalletDropdown>
    </Wallet>
  );
}
```

## Connection State Management

### Using Wagmi Hooks
```tsx
import { useAccount, useConnect, useDisconnect } from 'wagmi';

function ConnectionStatus() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div>
        <p>Connected to {address}</p>
        <button onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }

  return (
    <div>
      {connectors.map((connector) => (
        <button
          key={connector.id}
          onClick={() => connect({ connector })}
        >
          {connector.name}
        </button>
      ))}
    </div>
  );
}
```

### Custom Connection Logic
```tsx
import { useCallback } from 'react';
import { useAccount } from 'wagmi';

function useWalletConnection() {
  const { address, isConnected, isConnecting } = useAccount();

  const handleConnect = useCallback(() => {
    // Custom connection logic
    if (!isConnected) {
      // Trigger connection flow
    }
  }, [isConnected]);

  const handleDisconnect = useCallback(() => {
    // Custom disconnection logic
  }, []);

  return {
    address,
    isConnected,
    isConnecting,
    connect: handleConnect,
    disconnect: handleDisconnect,
  };
}
```

## Wallet Configuration

### Supported Wallets
```tsx
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors';

const connectors = [
  coinbaseWallet({
    appName: 'My OnchainKit App',
    preference: 'all', // 'all' | 'smartWalletOnly' | 'eoaOnly'
  }),
  metaMask(),
  walletConnect({
    projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID!,
  }),
];
```

### Custom Wallet Configuration
```tsx
import { createConfig } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';

const config = createConfig({
  chains: [base, mainnet],
  connectors,
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
  },
});
```

## Advanced Features

### Smart Wallet Integration
```tsx
import { coinbaseWallet } from 'wagmi/connectors';

const smartWalletConnector = coinbaseWallet({
  appName: 'My App',
  preference: 'smartWalletOnly',
  version: '4',
});
```

### Multi-Chain Support
```tsx
import { useAccount, useSwitchChain } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';

function ChainSwitcher() {
  const { chain } = useAccount();
  const { switchChain } = useSwitchChain();

  return (
    <div>
      <p>Current chain: {chain?.name}</p>
      <button onClick={() => switchChain({ chainId: base.id })}>
        Switch to Base
      </button>
      <button onClick={() => switchChain({ chainId: mainnet.id })}>
        Switch to Ethereum
      </button>
    </div>
  );
}
```

### Custom Styling
```tsx
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';

function StyledWallet() {
  return (
    <Wallet>
      <ConnectWallet 
        className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded"
        text="Connect Your Wallet"
      />
    </Wallet>
  );
}
```

## Error Handling

### Connection Errors
```tsx
import { useConnect } from 'wagmi';
import { useCallback } from 'react';

function WalletWithErrorHandling() {
  const { connect, error } = useConnect();

  const handleConnect = useCallback((connector) => {
    try {
      connect({ connector });
    } catch (err) {
      console.error('Connection failed:', err);
      // Handle error (show toast, modal, etc.)
    }
  }, [connect]);

  return (
    <div>
      {error && <p className="text-red-500">Error: {error.message}</p>}
      {/* Connection UI */}
    </div>
  );
}
```

### Retry Logic
```tsx
import { useConnect } from 'wagmi';
import { useState, useCallback } from 'react';

function RetryableConnection() {
  const [retryCount, setRetryCount] = useState(0);
  const { connect, error } = useConnect();

  const handleRetry = useCallback(async (connector) => {
    if (retryCount < 3) {
      setRetryCount(prev => prev + 1);
      try {
        await connect({ connector });
      } catch (err) {
        // Will retry automatically
      }
    }
  }, [connect, retryCount]);

  return (
    <div>
      {error && retryCount < 3 && (
        <button onClick={() => handleRetry(connector)}>
          Retry Connection ({retryCount}/3)
        </button>
      )}
    </div>
  );
}
```

## Best Practices

### 1. Always Wrap with Providers
```tsx
import { WagmiProvider } from 'wagmi';
import { OnchainKitProvider } from '@coinbase/onchainkit';

function App() {
  return (
    <WagmiProvider config={config}>
      <OnchainKitProvider apiKey={apiKey} chain={base}>
        <WalletInterface />
      </OnchainKitProvider>
    </WagmiProvider>
  );
}
```

### 2. Handle Loading States
```tsx
function WalletStatus() {
  const { isConnected, isConnecting } = useAccount();

  if (isConnecting) {
    return <div>Connecting...</div>;
  }

  if (isConnected) {
    return <div>Connected!</div>;
  }

  return <ConnectWallet />;
}
```

### 3. Graceful Degradation
```tsx
function WalletFeature() {
  const { isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="text-center p-4 border rounded">
        <p>Connect your wallet to access this feature</p>
        <ConnectWallet />
      </div>
    );
  }

  return <YourFeatureComponent />;
}
```

### 4. Security Considerations
- Never store private keys in client code
- Always validate wallet addresses on the server
- Use secure connections (HTTPS) in production
- Implement proper session management
- Validate all user inputs before signing

## Common Issues

### Issue: Wallet Not Connecting
**Solution**: Check WalletConnect project ID and network configuration

### Issue: Wrong Network
**Solution**: Implement chain switching or network detection

### Issue: Connection Persists Across Sessions
**Solution**: Implement proper disconnect handling and local storage cleanup

### Issue: Multiple Wallet Conflicts
**Solution**: Properly configure connector priorities and handle conflicts

## Testing

### Unit Tests
```tsx
import { render } from '@testing-library/react';
import { WagmiProvider } from 'wagmi';
import { WalletInterface } from './WalletInterface';

test('renders wallet connection button', () => {
  render(
    <WagmiProvider config={testConfig}>
      <WalletInterface />
    </WagmiProvider>
  );
  // Test wallet functionality
});
```

### E2E Tests
```javascript
// Playwright/Cypress test
test('wallet connection flow', async () => {
  await page.goto('/');
  await page.click('[data-testid="connect-wallet"]');
  await page.waitForSelector('[data-testid="wallet-connected"]');
});
```