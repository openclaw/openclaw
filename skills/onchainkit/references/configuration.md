# OnchainKit Configuration Reference

Complete configuration guide for OnchainKit applications.

## Environment Variables

### Required Variables
```bash
# Coinbase Developer Platform API Key
# Get from: https://portal.cdp.coinbase.com/
NEXT_PUBLIC_CDP_API_KEY=your-api-key-here

# WalletConnect Project ID
# Get from: https://cloud.walletconnect.com/
NEXT_PUBLIC_WC_PROJECT_ID=your-walletconnect-project-id
```

### Optional Variables
```bash
# Chain configuration (default: Base mainnet)
NEXT_PUBLIC_CHAIN_ID=8453

# OnchainKit Analytics (default: false)
NEXT_PUBLIC_ONCHAINKIT_ANALYTICS=true

# Custom RPC URL (optional)
NEXT_PUBLIC_RPC_URL=https://your-custom-rpc-endpoint.com

# App metadata
NEXT_PUBLIC_APP_NAME="My OnchainKit App"
NEXT_PUBLIC_APP_DESCRIPTION="Built with OnchainKit"
NEXT_PUBLIC_APP_URL="https://myapp.com"
NEXT_PUBLIC_APP_ICON="https://myapp.com/icon.png"
```

### Environment Setup Example
```bash
# .env.local
NEXT_PUBLIC_CDP_API_KEY=pk_live_1234567890abcdef
NEXT_PUBLIC_WC_PROJECT_ID=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
NEXT_PUBLIC_CHAIN_ID=8453
NEXT_PUBLIC_ONCHAINKIT_ANALYTICS=true
NEXT_PUBLIC_APP_NAME="My DeFi App"
```

## Provider Configuration

### Basic Provider Setup
```tsx
// providers.tsx
import { OnchainKitProvider } from '@coinbase/onchainkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { base } from 'wagmi/chains';
import { WagmiProvider } from 'wagmi';
import { getConfig } from './wagmi';

const queryClient = new QueryClient();

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <WagmiProvider config={getConfig()}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_CDP_API_KEY}
          chain={base}
          schemaId="0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9"
        >
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

### Advanced Provider Configuration
```tsx
import { OnchainKitProvider } from '@coinbase/onchainkit';
import { base, mainnet, polygon } from 'wagmi/chains';

export function AdvancedProviders({ children }: ProvidersProps) {
  return (
    <WagmiProvider config={getConfig()}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_CDP_API_KEY}
          chain={base}
          schemaId="0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9"
          config={{
            appearance: {
              mode: 'auto', // 'light' | 'dark' | 'auto'
              theme: 'default', // 'default' | 'hacker' | 'cyberpunk'
            },
            wallet: {
              display: 'modal', // 'modal' | 'embedded'
            },
          }}
        >
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

## Wagmi Configuration

### Basic Wagmi Config
```tsx
// wagmi.ts
import { http, createConfig } from 'wagmi';
import { base } from 'wagmi/chains';
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors';

export function getConfig() {
  return createConfig({
    chains: [base],
    connectors: [
      coinbaseWallet({
        appName: process.env.NEXT_PUBLIC_APP_NAME || 'OnchainKit App',
        preference: 'all',
      }),
      metaMask(),
      walletConnect({
        projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID!,
      }),
    ],
    ssr: true,
    transports: {
      [base.id]: http(),
    },
  });
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof getConfig>;
  }
}
```

### Multi-Chain Configuration
```tsx
import { http, createConfig } from 'wagmi';
import { base, mainnet, polygon, arbitrum, optimism } from 'wagmi/chains';

export function getMultiChainConfig() {
  return createConfig({
    chains: [base, mainnet, polygon, arbitrum, optimism],
    connectors: [
      coinbaseWallet({
        appName: process.env.NEXT_PUBLIC_APP_NAME || 'OnchainKit App',
        preference: 'all',
      }),
      metaMask(),
      walletConnect({
        projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID!,
        metadata: {
          name: process.env.NEXT_PUBLIC_APP_NAME || 'OnchainKit App',
          description: process.env.NEXT_PUBLIC_APP_DESCRIPTION || '',
          url: process.env.NEXT_PUBLIC_APP_URL || '',
          icons: [process.env.NEXT_PUBLIC_APP_ICON || ''],
        },
      }),
    ],
    ssr: true,
    transports: {
      [base.id]: http(process.env.NEXT_PUBLIC_RPC_URL_BASE),
      [mainnet.id]: http(process.env.NEXT_PUBLIC_RPC_URL_MAINNET),
      [polygon.id]: http(process.env.NEXT_PUBLIC_RPC_URL_POLYGON),
      [arbitrum.id]: http(process.env.NEXT_PUBLIC_RPC_URL_ARBITRUM),
      [optimism.id]: http(process.env.NEXT_PUBLIC_RPC_URL_OPTIMISM),
    },
  });
}
```

### Custom Chain Configuration
```tsx
import { defineChain } from 'viem';

export const customChain = defineChain({
  id: 123456,
  name: 'Custom Chain',
  network: 'custom',
  nativeCurrency: {
    decimals: 18,
    name: 'Custom Token',
    symbol: 'CUSTOM',
  },
  rpcUrls: {
    public: { http: ['https://rpc.customchain.com'] },
    default: { http: ['https://rpc.customchain.com'] },
  },
  blockExplorers: {
    etherscan: { name: 'CustomScan', url: 'https://scan.customchain.com' },
    default: { name: 'CustomScan', url: 'https://scan.customchain.com' },
  },
});

// Use in config
export function getCustomConfig() {
  return createConfig({
    chains: [base, customChain],
    // ... other config
  });
}
```

## Theme and Styling

### CSS Variables
```css
/* globals.css */
:root {
  --ock-bg-default: #ffffff;
  --ock-bg-default-hover: #f8f9fa;
  --ock-bg-alternate: #f1f3f4;
  --ock-bg-alternate-hover: #e8eaed;
  --ock-bg-inverse: #1a1b23;
  --ock-bg-primary: #0052ff;
  --ock-bg-primary-hover: #0040cc;
  --ock-bg-primary-active: #002999;
  --ock-bg-secondary: #e8eaed;
  --ock-bg-secondary-hover: #d2d5da;
  --ock-bg-secondary-active: #bcc0c7;
  
  /* Text colors */
  --ock-text-primary: #1a1b23;
  --ock-text-secondary: #5b616e;
  --ock-text-disabled: #8b92a5;
  --ock-text-inverse: #ffffff;
  --ock-text-error: #d73a49;
  --ock-text-success: #28a745;
  
  /* Border colors */
  --ock-border-default: #e8eaed;
  --ock-border-active: #0052ff;
  
  /* Border radius */
  --ock-border-radius: 8px;
}

[data-theme='dark'] {
  --ock-bg-default: #1a1b23;
  --ock-bg-default-hover: #2d3748;
  --ock-text-primary: #ffffff;
  --ock-text-secondary: #a0aec0;
}
```

### Custom Component Styling
```tsx
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import './custom-wallet.css';

function CustomStyledWallet() {
  return (
    <Wallet className="custom-wallet">
      <ConnectWallet 
        className="custom-connect-button"
        text="Connect Wallet"
      />
    </Wallet>
  );
}
```

```css
/* custom-wallet.css */
.custom-wallet {
  border-radius: 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 2px;
}

.custom-connect-button {
  background: white;
  color: #1a1b23;
  border-radius: 14px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.custom-connect-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
```

## API Configuration

### Coinbase Developer Platform Setup
1. Visit [https://portal.cdp.coinbase.com/](https://portal.cdp.coinbase.com/)
2. Create an account or sign in
3. Create a new project
4. Generate an API key
5. Copy the key to your environment variables

### WalletConnect Setup
1. Visit [https://cloud.walletconnect.com/](https://cloud.walletconnect.com/)
2. Create an account or sign in
3. Create a new project
4. Get the Project ID
5. Add your app metadata (name, description, URL, icon)
6. Copy the Project ID to your environment variables

### RPC Configuration
```tsx
// Using Alchemy
const alchemyConfig = {
  [base.id]: http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
  [mainnet.id]: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
};

// Using Infura
const infuraConfig = {
  [base.id]: http(`https://base-mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`),
  [mainnet.id]: http(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`),
};

// Using public RPCs (not recommended for production)
const publicConfig = {
  [base.id]: http(),
  [mainnet.id]: http(),
};
```

## Next.js Configuration

### next.config.js
```javascript
/** @type {import('next').NextConfig} */
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
    
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    
    return config;
  },
  env: {
    NEXT_PUBLIC_CDP_API_KEY: process.env.NEXT_PUBLIC_CDP_API_KEY,
    NEXT_PUBLIC_WC_PROJECT_ID: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
  },
};

module.exports = nextConfig;
```

### TypeScript Configuration
```json
{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "es6"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"],
      "@/components/*": ["./src/components/*"],
      "@/lib/*": ["./src/lib/*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

## Security Configuration

### Environment Variable Security
```bash
# Never commit these to version control
# Use .env.local for local development
# Use platform environment variables for production

# Development
NEXT_PUBLIC_CDP_API_KEY=pk_test_...
NEXT_PUBLIC_WC_PROJECT_ID=test_project_id

# Production
NEXT_PUBLIC_CDP_API_KEY=pk_live_...
NEXT_PUBLIC_WC_PROJECT_ID=production_project_id
```

### Content Security Policy
```javascript
// next.config.js
const nextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://vercel.live",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "connect-src 'self' https: wss:",
            ].join('; '),
          },
        ],
      },
    ];
  },
};
```

## Development vs Production

### Development Configuration
```tsx
// Development with detailed logging
const developmentConfig = {
  apiKey: process.env.NEXT_PUBLIC_CDP_API_KEY,
  chain: base,
  config: {
    appearance: {
      mode: 'light',
    },
    wallet: {
      display: 'modal',
    },
  },
  // Enable verbose logging in development
  debug: process.env.NODE_ENV === 'development',
};
```

### Production Configuration
```tsx
// Production with optimizations
const productionConfig = {
  apiKey: process.env.NEXT_PUBLIC_CDP_API_KEY,
  chain: base,
  config: {
    appearance: {
      mode: 'auto',
    },
    wallet: {
      display: 'modal',
    },
  },
  // Disable debugging in production
  debug: false,
};
```

## Configuration Validation

### Environment Validation
```tsx
function validateEnvironment() {
  const requiredEnvVars = [
    'NEXT_PUBLIC_CDP_API_KEY',
    'NEXT_PUBLIC_WC_PROJECT_ID',
  ];

  const missing = requiredEnvVars.filter(
    (envVar) => !process.env[envVar]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  // Validate API key format
  const apiKey = process.env.NEXT_PUBLIC_CDP_API_KEY;
  if (apiKey && !apiKey.startsWith('pk_')) {
    console.warn('CDP API key should start with "pk_"');
  }

  return true;
}

// Use in your app initialization
validateEnvironment();
```

### Runtime Configuration Check
```tsx
import { useOnchainKit } from '@coinbase/onchainkit';

function ConfigurationStatus() {
  const { config } = useOnchainKit();
  
  return (
    <div className="p-4 bg-gray-100 rounded">
      <h3>Configuration Status</h3>
      <p>API Key: {config.apiKey ? '✅ Configured' : '❌ Missing'}</p>
      <p>Chain: {config.chain.name}</p>
      <p>Schema ID: {config.schemaId ? '✅ Set' : '⚠️ Default'}</p>
    </div>
  );
}
```