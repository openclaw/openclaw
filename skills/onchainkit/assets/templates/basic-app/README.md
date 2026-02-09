# Basic OnchainKit App Template

A minimal OnchainKit application with wallet connection and identity display.

## Features

- Wallet connection (Coinbase Wallet, MetaMask, WalletConnect)
- User identity display (ENS name, avatar, address)
- Basic onchain interactions
- Responsive design
- TypeScript support

## Quick Start

1. Copy this template to your project directory
2. Install dependencies: `npm install`
3. Copy `.env.local.example` to `.env.local` and add your API keys
4. Run the development server: `npm run dev`

## File Structure

```
basic-app/
├── pages/
│   ├── _app.tsx          # Next.js app with providers
│   └── index.tsx         # Main page
├── components/
│   ├── WalletSection.tsx # Wallet connection component
│   └── UserProfile.tsx   # User identity display
├── lib/
│   ├── providers.tsx     # OnchainKit providers setup
│   └── wagmi.ts          # Wagmi configuration
├── styles/
│   └── globals.css       # Global styles with OnchainKit theme
├── .env.local.example    # Environment variables template
├── next.config.js        # Next.js configuration
├── package.json          # Dependencies
└── tsconfig.json         # TypeScript configuration
```

## Customization

### Adding More Features
- Token swaps: Add Swap components
- NFT display: Add NFT components  
- Transactions: Add Transaction components
- Payments: Add Checkout components

### Styling
- Modify CSS variables in `globals.css`
- Update component classes
- Add custom themes

### Chain Configuration
- Update chain in `lib/wagmi.ts`
- Add more chains as needed
- Configure custom RPC endpoints