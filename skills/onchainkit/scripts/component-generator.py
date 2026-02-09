#!/usr/bin/env python3
"""
OnchainKit Component Generator

Generates boilerplate OnchainKit components and integration code.
"""

import argparse
import sys
from pathlib import Path

def get_wallet_component_template():
    """Get wallet connection component template."""
    return '''import { 
  Wallet,
  ConnectWallet,
  WalletDropdown,
  WalletDropdownBasename,
  WalletDropdownDisconnect,
  WalletDropdownFundLink,
  WalletDropdownLink,
} from '@coinbase/onchainkit/wallet';
import { Avatar, Name, Identity } from '@coinbase/onchainkit/identity';
import { color } from '@coinbase/onchainkit/theme';

export function WalletConnection() {
  return (
    <div className="flex justify-end">
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
    </div>
  );
}'''

def get_swap_component_template():
    """Get token swap component template.""" 
    return '''import {
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
    image: 'https://d3r81g40ycuhqg.cloudfront.net/wallet/wais/44/2b/442b80bd16af0c0d9b22e03a16753823fe826e5bfd457292b55fa0ba8c1ba213-ZWUzYjJmZGUtMDYxNy00NDcyLTg0NjQtMWI4OGEwYjBiODE2',
  },
];

export function TokenSwap() {
  return (
    <div className="flex w-full">
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
}'''

def get_identity_component_template():
    """Get identity display component template."""
    return '''import {
  Identity,
  Avatar,
  Name,
  Badge,
  Address,
} from '@coinbase/onchainkit/identity';

interface UserIdentityProps {
  address: `0x${string}`;
  showAddress?: boolean;
  showBadge?: boolean;
  className?: string;
}

export function UserIdentity({ 
  address, 
  showAddress = false, 
  showBadge = true,
  className = ""
}: UserIdentityProps) {
  return (
    <Identity address={address} className={`flex items-center gap-2 ${className}`}>
      <Avatar className="h-8 w-8" />
      <div className="flex flex-col">
        <Name className="font-medium" />
        {showAddress && (
          <Address className="text-sm text-gray-500" />
        )}
      </div>
      {showBadge && <Badge />}
    </Identity>
  );
}'''

def get_transaction_component_template():
    """Get transaction component template."""
    return '''import { 
  Transaction,
  TransactionButton,
  TransactionSponsor,
  TransactionStatus,
  TransactionStatusAction,
  TransactionStatusLabel,
  TransactionToast,
} from '@coinbase/onchainkit/transaction';
import { Wallet, ConnectWallet } from '@coinbase/onchainkit/wallet';
import { useAccount } from 'wagmi';

interface TransactionWrapperProps {
  calls: any[];
  onSuccess?: (response: any) => void;
  onError?: (error: any) => void;
  children?: React.ReactNode;
}

export function TransactionWrapper({ 
  calls, 
  onSuccess, 
  onError,
  children 
}: TransactionWrapperProps) {
  const { address } = useAccount();

  if (!address) {
    return (
      <Wallet>
        <ConnectWallet />
      </Wallet>
    );
  }

  return (
    <Transaction
      calls={calls}
      onSuccess={onSuccess}
      onError={onError}
    >
      <TransactionButton text="Execute Transaction" />
      <TransactionSponsor />
      <TransactionStatus>
        <TransactionStatusLabel />
        <TransactionStatusAction />
      </TransactionStatus>
      <TransactionToast />
      {children}
    </Transaction>
  );
}'''

def get_nft_component_template():
    """Get NFT display component template."""
    return '''import { NFTCard } from '@coinbase/onchainkit/nft';

interface NFTDisplayProps {
  contract: `0x${string}`;
  tokenId: string;
  chain?: number;
  className?: string;
}

export function NFTDisplay({ 
  contract, 
  tokenId, 
  chain = 8453,
  className = ""
}: NFTDisplayProps) {
  return (
    <div className={`max-w-sm ${className}`}>
      <NFTCard
        contract={contract}
        tokenId={tokenId}
        chain={chain}
      />
    </div>
  );
}

interface NFTGridProps {
  nfts: Array<{
    contract: `0x${string}`;
    tokenId: string;
  }>;
  chain?: number;
  className?: string;
}

export function NFTGrid({ nfts, chain = 8453, className = "" }: NFTGridProps) {
  return (
    <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 ${className}`}>
      {nfts.map((nft, index) => (
        <NFTDisplay
          key={`${nft.contract}-${nft.tokenId}`}
          contract={nft.contract}
          tokenId={nft.tokenId}
          chain={chain}
        />
      ))}
    </div>
  );
}'''

def get_provider_template():
    """Get provider setup template."""
    return '''import { OnchainKitProvider } from '@coinbase/onchainkit';
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
}'''

def get_wagmi_config_template():
    """Get Wagmi configuration template."""
    return '''import { http, createConfig } from 'wagmi';
import { base } from 'wagmi/chains';
import { coinbaseWallet, metaMask, walletConnect } from 'wagmi/connectors';

export function getConfig() {
  return createConfig({
    chains: [base],
    connectors: [
      coinbaseWallet({
        appName: 'OnchainKit App',
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
}'''

def create_component_file(component_type, output_path, typescript=True):
    """Create a component file with the specified template."""
    
    templates = {
        'wallet': get_wallet_component_template,
        'swap': get_swap_component_template,
        'identity': get_identity_component_template,
        'transaction': get_transaction_component_template,
        'nft': get_nft_component_template,
        'provider': get_provider_template,
        'wagmi': get_wagmi_config_template,
    }
    
    if component_type not in templates:
        print(f"Unknown component type: {component_type}")
        return False
    
    template = templates[component_type]()
    extension = '.tsx' if typescript else '.jsx'
    
    # Determine filename
    filename_map = {
        'wallet': 'WalletConnection',
        'swap': 'TokenSwap', 
        'identity': 'UserIdentity',
        'transaction': 'TransactionWrapper',
        'nft': 'NFTDisplay',
        'provider': 'Providers',
        'wagmi': 'wagmi',
    }
    
    filename = f"{filename_map[component_type]}{extension}"
    full_path = output_path / filename
    
    # Create directory if it doesn't exist
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Write the file
    with open(full_path, 'w') as f:
        f.write(template)
    
    print(f"✅ Created {full_path}")
    return True

def main():
    parser = argparse.ArgumentParser(
        description="Generate OnchainKit component boilerplate",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Component types:
  wallet      - Wallet connection with dropdown
  swap        - Token swap interface
  identity    - User identity display
  transaction - Transaction execution wrapper
  nft         - NFT display components
  provider    - App providers setup
  wagmi       - Wagmi configuration

Examples:
  python component-generator.py wallet --output ./components
  python component-generator.py swap identity --output ./src/components
  python component-generator.py --all --output ./components
        """
    )
    
    parser.add_argument(
        "components",
        nargs="*",
        help="Component types to generate"
    )
    
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path("./components"),
        help="Output directory (default: ./components)"
    )
    
    parser.add_argument(
        "--all",
        action="store_true",
        help="Generate all available component types"
    )
    
    parser.add_argument(
        "--javascript",
        action="store_true", 
        help="Generate JavaScript files instead of TypeScript"
    )
    
    args = parser.parse_args()
    
    typescript = not args.javascript
    
    if args.all:
        components = ['wallet', 'swap', 'identity', 'transaction', 'nft', 'provider', 'wagmi']
    else:
        components = args.components
    
    if not components:
        print("No components specified. Use --all or specify component types.")
        parser.print_help()
        sys.exit(1)
    
    success_count = 0
    
    print(f"Generating OnchainKit components in {args.output}")
    print(f"Language: {'TypeScript' if typescript else 'JavaScript'}")
    print()
    
    for component in components:
        if create_component_file(component, args.output, typescript):
            success_count += 1
        else:
            print(f"❌ Failed to create {component} component")
    
    print(f"""
🎉 Generated {success_count}/{len(components)} components successfully!

Next steps:
1. Import the components in your app:
   import {{ WalletConnection }} from './components/WalletConnection';

2. Make sure you have the OnchainKit providers set up:
   import {{ Providers }} from './components/Providers';

3. Customize the components as needed for your use case.

Need help? Check the OnchainKit docs at https://onchainkit.xyz
""")

if __name__ == "__main__":
    main()