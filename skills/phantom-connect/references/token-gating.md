# Token-Gated Access

Implement token-gated features that require users to hold specific tokens.

## Architecture

```
1. User connects wallet (Phantom Connect)
2. App gets wallet address
3. Query blockchain for token balance
4. If balance meets criteria → grant access
5. Optional: Sign message to prove ownership (recommended for security)
```

## Client-Side Gating (Simple)

Best for low-stakes content and UI personalization.

```tsx
import { useState, useEffect } from "react";
import { useAccounts } from "@phantom/react-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const TOKEN_MINT = "YOUR_TOKEN_MINT_ADDRESS";
const REQUIRED_AMOUNT = 1;

function TokenGatedContent() {
  const { addresses, isConnected } = useAccounts();
  const [hasAccess, setHasAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConnected) {
      setLoading(false);
      return;
    }
    checkBalance();
  }, [isConnected, addresses]);

  async function checkBalance() {
    const wallet = addresses.find((a) => a.addressType === "solana")?.address;
    if (!wallet) {
      setLoading(false);
      return;
    }

    const connection = new Connection("https://api.mainnet-beta.solana.com");
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(TOKEN_MINT), new PublicKey(wallet));
      const account = await getAccount(connection, ata);
      setHasAccess(Number(account.amount) >= REQUIRED_AMOUNT);
    } catch {
      setHasAccess(false);
    } finally {
      setLoading(false);
    }
  }

  if (!isConnected) return <ConnectPrompt />;
  if (loading) return <Loading />;
  if (!hasAccess) return <AccessDenied />;
  return <ProtectedContent />;
}
```

## Server-Side Verification (Secure)

Best for valuable content and actual access control.

### Client: Sign Message

```tsx
import { useSolana, useAccounts } from "@phantom/react-sdk";

// Call hooks at component top level, then pass solana into helpers
function TokenGatedPage() {
  const { solana } = useSolana();
  // ... use verifyAccess(solana) in an event handler or useEffect
}

async function verifyAccess(solana: ReturnType<typeof useSolana>["solana"]) {
  const address = await solana.getPublicKey();
  const timestamp = Date.now();
  const message = `Verify ownership\nAddress: ${address}\nTimestamp: ${timestamp}`;

  const { signature } = await solana.signMessage(message);

  const res = await fetch("/api/verify-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signature, message }),
  });

  return await res.json();
}
```

### Server: Verify Signature + Check Balance

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import jwt from "jsonwebtoken";

export async function POST(req: Request) {
  const { address, signature, message } = await req.json();

  // 1. Verify signature FIRST
  const isValid = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    bs58.decode(signature),
    bs58.decode(address),
  );
  if (!isValid) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 2. Parse timestamp from the verified message (not from untrusted request field)
  const timestampMatch = message.match(/Timestamp:\s*(\d+)/);
  if (!timestampMatch || Date.now() - Number(timestampMatch[1]) > 5 * 60 * 1000) {
    return Response.json({ error: "Expired" }, { status: 400 });
  }

  // 3. Check token balance (account.amount is in raw base units)
  // For a token with 6 decimals, 1 token = 1_000_000 base units
  const REQUIRED_BALANCE = 1_000_000; // 1 token (adjust decimals per mint)
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(TOKEN_MINT), new PublicKey(address));
    const account = await getAccount(connection, ata);
    const balance = Number(account.amount);

    if (balance < REQUIRED_BALANCE) {
      return Response.json({ hasAccess: false, balance });
    }

    const accessToken = jwt.sign({ address, balance }, JWT_SECRET, { expiresIn: "24h" });
    return Response.json({ hasAccess: true, accessToken });
  } catch {
    return Response.json({ hasAccess: false, balance: 0 });
  }
}
```

## NFT Collection Gating

```ts
import { Metaplex } from "@metaplex-foundation/js";

async function checkNFTOwnership(wallet: string, collection: string) {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const metaplex = Metaplex.make(connection);

  const nfts = await metaplex.nfts().findAllByOwner({
    owner: new PublicKey(wallet),
  });

  return nfts.some((nft) => nft.collection?.address.toString() === collection);
}
```

## SOL Balance Gating

```ts
async function checkSolBalance(wallet: string, requiredSol: number) {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const balance = await connection.getBalance(new PublicKey(wallet));
  const solBalance = balance / 1e9; // Convert lamports to SOL
  return solBalance >= requiredSol;
}
```

## Security Best Practices

1. **Always verify server-side** for valuable content
2. **Use message signing** to prove wallet ownership
3. **Include timestamps** to prevent replay attacks
4. **Cache verification** with short TTLs
5. **Re-verify on sensitive actions**
