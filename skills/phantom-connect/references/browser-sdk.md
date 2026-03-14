# Browser SDK Reference

Complete reference for `@phantom/browser-sdk`.

## Installation

```bash
npm install @phantom/browser-sdk

# For Solana support
npm install @solana/web3.js
```

## Quick Start Template

Generate a project with the Phantom Embedded JS Starter:

```bash
npx -y create-solana-dapp@latest -t solana-foundation/templates/community/phantom-embedded-js
```

## SDK Initialization

### Injected Provider Only (Extension)

```ts
import { BrowserSDK, AddressType } from "@phantom/browser-sdk";

const sdk = new BrowserSDK({
  providers: ["injected"],
  addressTypes: [AddressType.solana],
});
```

### Multiple Auth Methods

```ts
const sdk = new BrowserSDK({
  providers: ["google", "apple", "injected"],
  appId: "your-app-id",
  addressTypes: [AddressType.solana],
  authOptions: {
    authUrl: "https://connect.phantom.app/login", // optional
    redirectUrl: "https://yourapp.com/callback", // required for OAuth
  },
  autoConnect: true,
});
```

## Connection

### Basic Connection

```ts
// Connect with a specific provider (pick one)
const result = await sdk.connect({ provider: "google" });
// OR: await sdk.connect({ provider: "apple" });
// OR: await sdk.connect({ provider: "injected" });

console.log("Connected:", result.addresses);
// [{ address: "...", addressType: "solana" }]
```

### Auto-Connect

```ts
const sdk = new BrowserSDK({
  providers: ["google", "apple"],
  appId: "your-app-id",
  addressTypes: [AddressType.solana],
  autoConnect: true, // Automatically reconnect existing sessions
});

// Or manually trigger
await sdk.autoConnect();
```

### Disconnect

```ts
await sdk.disconnect();
```

## Solana Operations (sdk.solana)

```ts
// Sign message
const { signature, rawSignature } = await sdk.solana.signMessage("Hello Solana!");

// Sign transaction — INJECTED PROVIDER ONLY (not supported for embedded/Google/Apple wallets)
const signedTx = await sdk.solana.signTransaction(transaction);

// Sign and send transaction
const result = await sdk.solana.signAndSendTransaction(transaction);
console.log("TX Hash:", result.hash);

// Network switching
await sdk.solana.switchNetwork("devnet"); // "mainnet-beta", "testnet", "devnet"

// Utilities
const publicKey = await sdk.solana.getPublicKey();
const isConnected = sdk.solana.isConnected();
```

## Auto-Confirm (Injected Provider Only)

```ts
import { NetworkId } from "@phantom/browser-sdk";

// Enable for specific chains
await sdk.enableAutoConfirm({
  chains: [NetworkId.SOLANA_MAINNET],
});

// Enable for all supported chains
await sdk.enableAutoConfirm();

// Disable
await sdk.disableAutoConfirm();

// Get status
const status = await sdk.getAutoConfirmStatus();

// Get supported chains
const chains = await sdk.getSupportedAutoConfirmChains();
```

## Extension Detection

```ts
import { waitForPhantomExtension } from "@phantom/browser-sdk";

const isAvailable = await waitForPhantomExtension(5000); // 5s timeout

if (isAvailable) {
  console.log("Phantom extension installed");
} else {
  console.log("Extension not found - offer OAuth login");
}
```

## Wallet Discovery

Discover all injected wallets using Wallet Standard (Solana):

```ts
// Async discovery
const wallets = await sdk.discoverWallets();
console.log(wallets);
// [
//   { id: "phantom", name: "Phantom", icon: "...", addressTypes: [...] },
//   { id: "backpack", name: "Backpack", icon: "...", addressTypes: [...] },
// ]

// Get already discovered (sync)
const cachedWallets = sdk.getDiscoveredWallets();
```

## Event Handlers

```ts
// Connection started
sdk.on("connect_start", (data) => {
  console.log("Starting:", data.source); // "auto-connect" | "manual-connect"
});

// Connection successful
sdk.on("connect", (data) => {
  console.log("Connected:", data.addresses);
  console.log("Provider:", data.provider);
});

// Connection failed
sdk.on("connect_error", (data) => {
  console.error("Failed:", data.error);
});

// Disconnected
sdk.on("disconnect", (data) => {
  console.log("Disconnected");
});

// General errors
sdk.on("error", (error) => {
  console.error("SDK Error:", error);
});

// Remove listener
sdk.off("connect", handleConnect);
```

### Events with Auto-Connect

```ts
const sdk = new BrowserSDK({
  providers: ["google"],
  appId: "your-app-id",
  addressTypes: [AddressType.solana],
  autoConnect: true,
});

// Set up listeners BEFORE autoConnect triggers
sdk.on("connect", (data) => {
  updateUI(data.addresses);
});

sdk.on("connect_error", (data) => {
  showLoginButton();
});

await sdk.autoConnect();
```

## Debug Configuration

```ts
import { DebugLevel } from "@phantom/browser-sdk";

// Enable/disable at runtime
sdk.enableDebug();
sdk.disableDebug();

// Set level
sdk.setDebugLevel(DebugLevel.INFO);
// Levels: ERROR (0), WARN (1), INFO (2), DEBUG (3)

// Set callback
sdk.setDebugCallback((message) => {
  console.log(`[${message.level}] ${message.category}: ${message.message}`);
});

// Configure all at once
sdk.configureDebug({
  enabled: true,
  level: DebugLevel.DEBUG,
  callback: (msg) => console.log(msg),
});
```

## AddressType Values

| AddressType          | Chains                   |
| -------------------- | ------------------------ |
| `AddressType.solana` | Mainnet, Devnet, Testnet |

## Supported Solana Networks

| Network | Cluster      |
| ------- | ------------ |
| Mainnet | mainnet-beta |
| Devnet  | devnet       |
| Testnet | testnet      |

## Complete Example

```ts
import { BrowserSDK, AddressType, waitForPhantomExtension } from "@phantom/browser-sdk";

// Initialize
const sdk = new BrowserSDK({
  providers: ["google", "apple", "injected"],
  appId: "your-app-id",
  addressTypes: [AddressType.solana],
  autoConnect: true,
});

// Set up event handlers
sdk.on("connect", ({ addresses }) => {
  document.getElementById("status").textContent = `Connected: ${addresses[0].address}`;
});

sdk.on("connect_error", ({ error }) => {
  document.getElementById("status").textContent = `Error: ${error.message}`;
});

// Connect button
document.getElementById("connectBtn").addEventListener("click", async () => {
  const hasExtension = await waitForPhantomExtension(2000);
  const provider = hasExtension ? "injected" : "google";
  await sdk.connect({ provider });
});

// Sign message button
document.getElementById("signBtn").addEventListener("click", async () => {
  const { signature } = await sdk.solana.signMessage("Hello!");
  console.log("Signature:", signature);
});

// Disconnect button
document.getElementById("disconnectBtn").addEventListener("click", async () => {
  await sdk.disconnect();
  document.getElementById("status").textContent = "Disconnected";
});
```
