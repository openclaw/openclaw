# React Native SDK Reference

Complete reference for `@phantom/react-native-sdk`.

## Installation

```bash
npm install @phantom/react-native-sdk

# Expo peer dependencies
npx expo install expo-secure-store expo-web-browser expo-auth-session expo-router react-native-svg

# Required polyfill
npm install react-native-get-random-values

# For Solana support
npm install @solana/web3.js
```

## Critical Setup

### 1. Polyfill (MUST BE FIRST IMPORT)

```tsx
// App.tsx or _layout.tsx - THIS MUST BE THE VERY FIRST IMPORT
import "react-native-get-random-values";

import { PhantomProvider } from "@phantom/react-native-sdk";
// ... other imports
```

### 2. Configure app.json (Expo)

```json
{
  "expo": {
    "name": "My Wallet App",
    "slug": "my-wallet-app",
    "scheme": "mywalletapp",
    "plugins": ["expo-router", "expo-secure-store", "expo-web-browser", "expo-auth-session"]
  }
}
```

## PhantomProvider Configuration

```tsx
import "react-native-get-random-values";
import { PhantomProvider, AddressType, darkTheme } from "@phantom/react-native-sdk";

export default function App() {
  return (
    <PhantomProvider
      config={{
        providers: ["google", "apple"],
        appId: "your-app-id",
        scheme: "mywalletapp",
        addressTypes: [AddressType.solana],
        authOptions: {
          redirectUrl: "mywalletapp://phantom-auth-callback",
        },
      }}
      theme={darkTheme}
      appIcon="https://yourapp.com/icon.png"
      appName="Your App"
    >
      <YourApp />
    </PhantomProvider>
  );
}
```

## Available Hooks

| Hook            | Purpose                  | Returns                                |
| --------------- | ------------------------ | -------------------------------------- |
| `useModal`      | Control connection modal | `{ open, close, isOpened }`            |
| `usePhantom`    | Access wallet/user state | `{ isConnected, isLoading }`           |
| `useConnect`    | Connect to wallet        | `{ connect, isConnecting, error }`     |
| `useAccounts`   | Get wallet addresses     | `{ addresses, isConnected, walletId }` |
| `useDisconnect` | Disconnect wallet        | `{ disconnect, isDisconnecting }`      |
| `useSolana`     | Solana operations        | `{ solana, isAvailable }`              |

## Hook Examples

### useModal (Recommended Approach)

```tsx
import { View, Button, Text } from "react-native";
import { useModal, useAccounts } from "@phantom/react-native-sdk";

export function WalletScreen() {
  const { open, close, isOpened } = useModal();
  const { isConnected, addresses } = useAccounts();

  if (!isConnected) {
    return (
      <View style={{ padding: 20 }}>
        <Button title="Connect Wallet" onPress={open} />
      </View>
    );
  }

  return (
    <View style={{ padding: 20 }}>
      <Text>Connected!</Text>
      {addresses.map((addr, i) => (
        <Text key={i}>
          {addr.addressType}: {addr.address}
        </Text>
      ))}
      <Button title="Manage Wallet" onPress={open} />
    </View>
  );
}
```

### useConnect (Direct Connection)

```tsx
import { View, Button, Text, Alert } from "react-native";
import { useConnect, useAccounts, useDisconnect } from "@phantom/react-native-sdk";

export function WalletScreen() {
  const { connect, isConnecting, error } = useConnect();
  const { addresses, isConnected } = useAccounts();
  const { disconnect } = useDisconnect();

  const handleConnect = async () => {
    try {
      await connect({ provider: "google" });
      Alert.alert("Success", "Wallet connected!");
    } catch (err) {
      Alert.alert("Error", err.message);
    }
  };

  if (!isConnected) {
    return (
      <View>
        <Button
          title={isConnecting ? "Connecting..." : "Connect with Google"}
          onPress={handleConnect}
          disabled={isConnecting}
        />
        {error && <Text style={{ color: "red" }}>{error.message}</Text>}
      </View>
    );
  }

  return (
    <View>
      {addresses.map((addr, i) => (
        <Text key={i}>
          {addr.addressType}: {addr.address}
        </Text>
      ))}
      <Button title="Disconnect" onPress={disconnect} />
    </View>
  );
}
```

### useSolana

```tsx
import { Alert } from "react-native";
import { useSolana } from "@phantom/react-native-sdk";

function SolanaActions() {
  const { solana, isAvailable } = useSolana();

  if (!isAvailable) return null;

  const signMessage = async () => {
    try {
      const { signature } = await solana.signMessage("Hello from Solana!");
      Alert.alert("Signed!", signature.slice(0, 20) + "...");
    } catch (err) {
      Alert.alert("Error", err.message);
    }
  };

  const sendTransaction = async (transaction) => {
    try {
      const result = await solana.signAndSendTransaction(transaction);
      Alert.alert("Sent!", `TX: ${result.hash}`);
    } catch (err) {
      Alert.alert("Error", err.message);
    }
  };

  return <Button title="Sign Message" onPress={signMessage} />;
}
```

## Authentication Flow

1. User taps "Connect Wallet"
2. System browser opens (Safari iOS / Chrome Android)
3. User authenticates with Google or Apple
4. Browser redirects back via custom URL scheme
5. SDK processes auth result automatically
6. Wallet connected and ready

### Redirect URL Format

```
{scheme}://phantom-auth-callback?wallet_id=...&session_id=...
```

## Security Features

- **iOS**: Keychain Services with hardware security
- **Android**: Android Keystore with hardware-backed keys
- Uses system browser (not in-app webview)
- Verifies redirect origins automatically

## Debug Configuration

```tsx
<PhantomProvider
  config={config}
  debugConfig={{
    enabled: true,
  }}
>
  ...
</PhantomProvider>
```

## Solana Configuration

```tsx
<PhantomProvider
  config={{
    providers: ["google", "apple"],
    appId: "your-app-id",
    scheme: "mycompany-wallet",
    addressTypes: [AddressType.solana],
    authOptions: {
      redirectUrl: "mycompany-wallet://auth/success",
    },
  }}
  theme={darkTheme}
>
  ...
</PhantomProvider>
```

## Supported Solana Networks

| Network | Cluster      |
| ------- | ------------ |
| Mainnet | mainnet-beta |
| Devnet  | devnet       |
| Testnet | testnet      |

## Common Issues

### App crashes on startup

Ensure `react-native-get-random-values` is imported FIRST, before any other imports.

### Auth redirect not working

1. Verify `scheme` in app.json matches config
2. Ensure all Expo plugins are configured
3. Run `npx expo prebuild` after changes

### "appId required" error

Add your appId from Phantom Portal when using google/apple providers.
