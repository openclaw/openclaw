# OnchainKit Troubleshooting Guide

Common issues and solutions when working with OnchainKit applications.

## Installation Issues

### Issue: npm install fails with peer dependency warnings
```
npm WARN peer dep missing: react@^19.0.0
```

**Solutions:**
1. Install peer dependencies explicitly:
```bash
npm install react@^19 react-dom@^19 viem@^2.27 wagmi@^2.16
```

2. Use `--legacy-peer-deps` flag:
```bash
npm install --legacy-peer-deps
```

3. Update to compatible versions:
```bash
npm update react react-dom
```

### Issue: TypeScript errors during installation
```
Type errors in node_modules/@coinbase/onchainkit
```

**Solutions:**
1. Skip type checking during build:
```bash
npm run build -- --no-type-check
```

2. Update TypeScript configuration:
```json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
```

## Environment Configuration

### Issue: "Missing API key" error
```
Error: OnchainKit requires an API key
```

**Solutions:**
1. Check environment variable name:
```bash
# Correct
NEXT_PUBLIC_CDP_API_KEY=pk_live_...

# Incorrect
CDP_API_KEY=pk_live_...  # Missing NEXT_PUBLIC_
```

2. Verify `.env.local` is in project root
3. Restart development server after adding environment variables
4. Check API key format (should start with `pk_`)

### Issue: WalletConnect connection fails
```
Error: WalletConnect project ID is required
```

**Solutions:**
1. Get project ID from [https://cloud.walletconnect.com/](https://cloud.walletconnect.com/)
2. Add to environment:
```bash
NEXT_PUBLIC_WC_PROJECT_ID=your-project-id-here
```

3. Verify project settings in WalletConnect dashboard
4. Check domain allowlist in WalletConnect settings

### Issue: Environment variables not loading
```
process.env.NEXT_PUBLIC_CDP_API_KEY is undefined
```

**Solutions:**
1. Ensure variables start with `NEXT_PUBLIC_` for client-side access
2. Check file location (must be in project root)
3. Restart development server
4. Verify no syntax errors in `.env.local`

## Wallet Connection Issues

### Issue: Wallet not connecting
```
Error: Connector not found
```

**Solutions:**
1. Check wallet extension is installed and enabled
2. Verify Wagmi connector configuration:
```tsx
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors';

const connectors = [
  coinbaseWallet({
    appName: 'Your App Name',
    preference: 'all',
  }),
  metaMask(),
  walletConnect({
    projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID!,
  }),
];
```

3. Clear browser cache and cookies
4. Try a different wallet/browser combination

### Issue: Wrong network
```
Error: Chain not supported
```

**Solutions:**
1. Add chain switching:
```tsx
import { useSwitchChain } from 'wagmi';

function NetworkSwitcher() {
  const { switchChain } = useSwitchChain();
  
  return (
    <button onClick={() => switchChain({ chainId: 8453 })}>
      Switch to Base
    </button>
  );
}
```

2. Configure multiple chains in Wagmi:
```tsx
import { base, mainnet } from 'wagmi/chains';

const config = createConfig({
  chains: [base, mainnet],
  // ... other config
});
```

### Issue: Connection persists after disconnect
```
Wallet shows as connected after disconnect
```

**Solutions:**
1. Clear local storage:
```tsx
const handleDisconnect = () => {
  disconnect();
  localStorage.removeItem('wagmi.store');
  window.location.reload();
};
```

2. Implement proper cleanup:
```tsx
import { useEffect } from 'react';
import { useAccount } from 'wagmi';

function ConnectionManager() {
  const { isConnected } = useAccount();

  useEffect(() => {
    if (!isConnected) {
      // Clear app state when wallet disconnects
      localStorage.removeItem('user-preferences');
    }
  }, [isConnected]);
}
```

## Component Issues

### Issue: Components not rendering
```
Nothing appears when using OnchainKit components
```

**Solutions:**
1. Ensure providers are properly set up:
```tsx
// _app.tsx or root component
import { Providers } from '../lib/providers';

export default function App({ Component, pageProps }) {
  return (
    <Providers>
      <Component {...pageProps} />
    </Providers>
  );
}
```

2. Check component imports:
```tsx
// Correct
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';

// Incorrect
import { Wallet, ConnectWallet } from '@coinbase/onchainkit';
```

3. Import CSS:
```tsx
import '@coinbase/onchainkit/styles.css';
```

### Issue: Styling issues/components look broken
```
Components appear unstyled or layout is broken
```

**Solutions:**
1. Import OnchainKit CSS:
```tsx
// pages/_app.tsx
import '@coinbase/onchainkit/styles.css';
import '../styles/globals.css';
```

2. Check CSS order (OnchainKit CSS should come first)
3. Verify Tailwind CSS isn't conflicting:
```css
/* Exclude OnchainKit classes from Tailwind reset */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* OnchainKit overrides */
@layer components {
  .ockConnectWallet {
    @apply !important;
  }
}
```

### Issue: TypeScript errors with components
```
Property 'xyz' does not exist on type...
```

**Solutions:**
1. Update TypeScript and `@types/react`:
```bash
npm update typescript @types/react @types/react-dom
```

2. Add type declarations:
```tsx
// types/onchainkit.d.ts
declare module '@coinbase/onchainkit/wallet' {
  export interface WalletProps {
    children?: React.ReactNode;
    className?: string;
  }
}
```

## Transaction Issues

### Issue: Transactions fail with gas errors
```
Error: insufficient funds for gas * price + value
```

**Solutions:**
1. Check ETH balance for gas:
```tsx
import { useBalance } from 'wagmi';

function GasChecker() {
  const { data: balance } = useBalance({
    address: userAddress,
  });

  if (balance && balance.value < parseEther('0.001')) {
    return <div>Insufficient ETH for gas fees</div>;
  }
}
```

2. Estimate gas before transaction:
```tsx
import { useEstimateGas } from 'wagmi';

function TransactionWithGasEstimate() {
  const { data: gasEstimate } = useEstimateGas({
    to: contractAddress,
    data: encodedFunctionData,
  });

  return <div>Estimated gas: {gasEstimate?.toString()}</div>;
}
```

### Issue: Transaction rejected by user
```
Error: User rejected the request
```

**Solutions:**
1. Add user-friendly messaging:
```tsx
const handleTransaction = async () => {
  try {
    await sendTransaction();
  } catch (error) {
    if (error.code === 4001) {
      console.log('Transaction cancelled by user');
      // Show gentle message
    } else {
      console.error('Transaction failed:', error);
    }
  }
};
```

2. Provide clear transaction details before confirmation

### Issue: Slow transaction confirmation
```
Transaction pending for long time
```

**Solutions:**
1. Implement transaction tracking:
```tsx
import { useWaitForTransactionReceipt } from 'wagmi';

function TransactionTracker({ hash }) {
  const { data, isLoading } = useWaitForTransactionReceipt({
    hash,
  });

  return (
    <div>
      {isLoading && <div>Waiting for confirmation...</div>}
      {data && <div>Transaction confirmed!</div>}
    </div>
  );
}
```

2. Allow gas price adjustment for faster confirmation

## API and Network Issues

### Issue: API calls failing
```
Error: CDP API request failed
```

**Solutions:**
1. Check API key validity and permissions
2. Verify API key environment variable
3. Check network connectivity
4. Monitor API rate limits
5. Use proper error handling:
```tsx
const fetchTokenData = async () => {
  try {
    const response = await fetch('/api/tokens');
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch token data:', error);
    // Implement retry logic or fallback
  }
};
```

### Issue: RPC endpoint errors
```
Error: RPC request failed
```

**Solutions:**
1. Use reliable RPC providers (Alchemy, Infura, Coinbase)
2. Implement fallback RPCs:
```tsx
const config = createConfig({
  transports: {
    [base.id]: fallback([
      http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`),
      http(`https://base-mainnet.infura.io/v3/${infuraKey}`),
      http(), // Public RPC as fallback
    ]),
  },
});
```

3. Add retry logic for RPC calls

## Performance Issues

### Issue: Slow app loading
```
App takes long time to load or respond
```

**Solutions:**
1. Implement lazy loading:
```tsx
import { lazy, Suspense } from 'react';

const SwapComponent = lazy(() => import('./components/SwapComponent'));

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SwapComponent />
    </Suspense>
  );
}
```

2. Optimize bundle size:
```tsx
// Import specific components instead of entire modules
import { Wallet } from '@coinbase/onchainkit/wallet';
import { Swap } from '@coinbase/onchainkit/swap';
```

3. Use React Query for caching:
```tsx
import { useQuery } from '@tanstack/react-query';

function TokenPrice({ tokenAddress }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tokenPrice', tokenAddress],
    queryFn: () => fetchTokenPrice(tokenAddress),
    staleTime: 60000, // Cache for 1 minute
  });
}
```

## Development Issues

### Issue: Hot reload not working
```
Changes not reflected in development
```

**Solutions:**
1. Restart development server
2. Clear Next.js cache:
```bash
rm -rf .next
npm run dev
```

3. Check file watchers (especially on Linux):
```bash
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Issue: Build failures
```
Build fails in production but works in development
```

**Solutions:**
1. Run build locally to debug:
```bash
npm run build
```

2. Check for environment-specific code:
```tsx
// Avoid window/document access during SSR
const isClient = typeof window !== 'undefined';

if (isClient) {
  // Client-only code
}
```

3. Configure Next.js for proper builds:
```javascript
// next.config.js
const nextConfig = {
  experimental: {
    esmExternals: true,
  },
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};
```

## Getting Help

### Debug Information to Collect
1. Browser console errors
2. Network tab for failed requests
3. OnchainKit version: `npm list @coinbase/onchainkit`
4. React/Next.js versions
5. Environment configuration (without sensitive data)

### Useful Debug Commands
```bash
# Check versions
npm list @coinbase/onchainkit wagmi viem react

# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install

# Test build
npm run build

# Check environment
env | grep NEXT_PUBLIC_
```

### Community Resources
- OnchainKit Discord: [Coinbase Developer Platform](https://discord.gg/invite/cdp)
- GitHub Issues: [OnchainKit Repository](https://github.com/coinbase/onchainkit/issues)
- Documentation: [onchainkit.xyz](https://onchainkit.xyz)
- Twitter: [@OnchainKit](https://x.com/OnchainKit)

### When to Contact Support
- API key or account issues
- Platform-specific problems
- Security concerns
- Feature requests
- Bug reports with reproduction steps