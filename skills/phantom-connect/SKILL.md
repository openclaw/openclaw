---
name: phantom-connect
description: "Use when the user wants to build a wallet-connected application with Phantom Connect SDK for Solana. Use for integrating Phantom wallets into React, React Native, or vanilla JS/TS apps — including wallet connection, social login with Google or Apple, embedded wallets, transaction signing, message signing, token-gated access, crypto payments, and NFT minting. Covers @phantom/react-sdk, @phantom/react-native-sdk, and @phantom/browser-sdk. Do NOT use for direct wallet operations (use phantom-wallet skill instead)."
homepage: https://docs.phantom.com
metadata: { "openclaw": { "emoji": "👻" } }
---

# Phantom Connect SDK

Build wallet-connected Solana applications with the Phantom Connect SDK ecosystem.

## SDK Selection

| Platform                   | SDK              | Package                     |
| -------------------------- | ---------------- | --------------------------- |
| React web apps             | React SDK        | `@phantom/react-sdk`        |
| React Native / Expo        | React Native SDK | `@phantom/react-native-sdk` |
| Vanilla JS / Vue / Angular | Browser SDK      | `@phantom/browser-sdk`      |

## Prerequisites

1. **Phantom Portal Account** — Register at [portal.phantom.com](https://portal.phantom.com)
2. **App ID** — Get from Portal > App > Set Up
3. **Allowlisted URLs** — Add domains and redirect URLs in Portal

## Auth Providers

| Provider     | Description                    | Requires appId |
| ------------ | ------------------------------ | -------------- |
| `"injected"` | Phantom browser extension      | No             |
| `"google"`   | Google OAuth (embedded wallet) | Yes            |
| `"apple"`    | Apple ID (embedded wallet)     | Yes            |

## Critical Rules

1. **Always use `signAndSendTransaction`** — `signTransaction` and `signAllTransactions` are NOT supported for embedded wallets
2. **Always use `LAMPORTS_PER_SOL`** from `@solana/web3.js` for amount conversion — never hardcode `1000000000`
3. **Wrap all async SDK calls in try-catch** — users can reject prompts at any time
4. **Check `isConnected` before signing** — verify wallet connection before any operation
5. **React Native: `react-native-get-random-values` must be the FIRST import** — before any other imports
6. **BrowserSDK must be a singleton** — create one instance per app, never multiple
7. **Import `AddressType` from `@phantom/browser-sdk`** (React Native SDK re-exports it from `@phantom/react-native-sdk`)
8. **Use devnet for testing, mainnet-beta for production** — never test against mainnet with real funds
9. **Never expose private keys** — Phantom handles all signing internally
10. **Embedded wallet spending limit**: $1,000 USD per day per app per user
11. **Social login sessions persist 7 days** from last auth event — handle expiration gracefully

## Quick Start

### React SDK

```tsx
import { PhantomProvider, useModal, usePhantom, darkTheme } from "@phantom/react-sdk";
import { AddressType } from "@phantom/browser-sdk";

function App() {
  return (
    <PhantomProvider
      config={{
        providers: ["google", "apple", "injected"],
        appId: "your-app-id",
        addressTypes: [AddressType.solana],
        authOptions: { redirectUrl: "https://yourapp.com/callback" },
      }}
      theme={darkTheme}
    >
      <YourApp />
    </PhantomProvider>
  );
}
```

### React Native SDK

```tsx
// CRITICAL: Must be first import
import "react-native-get-random-values";
import { PhantomProvider, AddressType, darkTheme } from "@phantom/react-native-sdk";

// Requires app.json: { "expo": { "scheme": "myapp", "plugins": [...] } }
```

### Browser SDK

```ts
import { BrowserSDK, AddressType } from "@phantom/browser-sdk";

const sdk = new BrowserSDK({
  providers: ["google", "apple", "injected"],
  appId: "your-app-id",
  addressTypes: [AddressType.solana],
  autoConnect: true,
});
```

## Reference Docs

For detailed implementation patterns, read these files:

- [references/react-sdk.md](references/react-sdk.md) — Complete React SDK reference (hooks, components, theming)
- [references/react-native-sdk.md](references/react-native-sdk.md) — Mobile setup, Expo config, deep links
- [references/browser-sdk.md](references/browser-sdk.md) — Vanilla JS patterns, events, wallet discovery
- [references/transactions.md](references/transactions.md) — Solana transaction patterns (SOL, SPL tokens)
- [references/payments.md](references/payments.md) — Crypto payment flows (SOL, USDC, backend verification)
- [references/token-gating.md](references/token-gating.md) — Token-gated access (client-side, server-side, NFT)
- [references/nft-minting.md](references/nft-minting.md) — NFT mint pages, Metaplex Core, compressed NFTs

## Common Issues

| Issue                   | Solution                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------- |
| "appId required"        | Add appId from Phantom Portal when using google/apple providers                         |
| Redirect not working    | Allowlist redirectUrl in Phantom Portal                                                 |
| React Native crashes    | Import `react-native-get-random-values` as FIRST import                                 |
| Extension not detected  | Use `waitForPhantomExtension()` with timeout                                            |
| `signTransaction` error | Use `signAndSendTransaction` instead — embedded wallets don't support `signTransaction` |

## Resources

- [Phantom Portal](https://portal.phantom.com) — App registration
- [Phantom Docs](https://docs.phantom.com) — Full documentation
- [SDK Examples](https://github.com/phantom/wallet-sdk/tree/main/examples) — Working demos
- [MCP Server](https://docs.phantom.com/resources/mcp-server) — AI docs access
