# NFT Minting

Build NFT mint pages and drop experiences.

## Mint Page Pattern

```tsx
import { useState } from "react";
import { PhantomProvider, useModal, useAccounts, useSolana, darkTheme } from "@phantom/react-sdk";
import { AddressType } from "@phantom/browser-sdk";
import { VersionedTransaction } from "@solana/web3.js";

function MintPage() {
  const { isConnected, addresses } = useAccounts();
  const { open } = useModal();
  const { solana } = useSolana();
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<"idle" | "minting" | "success" | "error">("idle");

  const PRICE = 0.5; // SOL
  const MAX_PER_WALLET = 5;

  async function handleMint() {
    if (!isConnected) {
      open();
      return;
    }

    setStatus("minting");
    try {
      const wallet = addresses.find((a) => a.addressType === "solana")?.address;
      if (!wallet) {
        setStatus("error");
        return;
      }

      // Get transaction from backend
      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, quantity }),
      });
      const { transaction } = await res.json();

      // Sign and send
      const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
      const { hash } = await solana.signAndSendTransaction(tx);

      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <h1>Mint NFT</h1>
      <p>Price: {PRICE} SOL each</p>

      <div>
        <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>-</button>
        <span>{quantity}</span>
        <button onClick={() => setQuantity((q) => Math.min(MAX_PER_WALLET, q + 1))}>+</button>
      </div>

      <p>Total: {(PRICE * quantity).toFixed(2)} SOL</p>

      <button onClick={handleMint} disabled={status === "minting"}>
        {!isConnected ? "Connect Wallet" : status === "minting" ? "Minting..." : "Mint"}
      </button>

      {status === "success" && <p>Successfully minted!</p>}
    </div>
  );
}
```

## Backend: Metaplex Core

```ts
// /api/mint.ts
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { create, mplCore } from "@metaplex-foundation/mpl-core";
import {
  generateSigner,
  publicKey,
  keypairIdentity,
  createKeypairFromSecretKey,
  transactionBuilder,
} from "@metaplex-foundation/umi";

export async function POST(req: Request) {
  const { wallet, quantity } = await req.json();

  // Load mint authority from environment (never hardcode)
  const authorityKeypair = createKeypairFromSecretKey(
    Uint8Array.from(JSON.parse(process.env.MINT_AUTHORITY_SECRET_KEY!)),
  );

  const umi = createUmi("https://api.mainnet-beta.solana.com")
    .use(mplCore())
    .use(keypairIdentity(authorityKeypair));

  // Build one create instruction per requested quantity
  let builder = transactionBuilder();
  for (let i = 0; i < quantity; i++) {
    const asset = generateSigner(umi);
    builder = builder.add(
      create(umi, {
        asset,
        name: `NFT #${i + 1}`,
        uri: "https://arweave.net/metadata.json",
        owner: publicKey(wallet),
      }),
    );
  }

  const built = await builder.build(umi);
  const serialized = Buffer.from(umi.transactions.serialize(built)).toString("base64");

  return Response.json({ transaction: serialized });
}
```

## Allowlist Mint

```tsx
async function allowlistMint(solana: any, wallet: string, qty: number) {
  const { proof, transaction } = await fetch(`/api/allowlist-mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, quantity: qty }),
  }).then((r) => r.json());

  if (!proof) throw new Error("Not on allowlist");

  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  const { hash } = await solana.signAndSendTransaction(tx);

  return hash;
}
```

## Metadata Format (Metaplex)

```json
{
  "name": "Collection #1",
  "symbol": "COLL",
  "description": "Description",
  "image": "https://arweave.net/image.png",
  "attributes": [{ "trait_type": "Background", "value": "Blue" }],
  "properties": {
    "files": [{ "uri": "https://arweave.net/image.png", "type": "image/png" }]
  }
}
```

## Compressed NFTs (cNFTs)

For large collections, use compressed NFTs to reduce costs:

```ts
import { createTree, mintV1 } from "@metaplex-foundation/mpl-bubblegum";

// Create merkle tree (one-time setup)
const tree = generateSigner(umi);
await createTree(umi, {
  merkleTree: tree,
  maxDepth: 14, // Up to 16,384 NFTs
  maxBufferSize: 64,
}).sendAndConfirm(umi);

// Mint compressed NFT
await mintV1(umi, {
  leafOwner: publicKey(wallet),
  merkleTree: tree.publicKey,
  metadata: {
    name: "cNFT #1",
    uri: "https://arweave.net/metadata.json",
    sellerFeeBasisPoints: 500, // 5%
    collection: { key: collectionMint, verified: false },
    creators: [{ address: umi.identity.publicKey, verified: true, share: 100 }],
  },
}).sendAndConfirm(umi);
```

## Best Practices

1. **Generate transactions server-side** - Don't expose mint authority
2. **Validate wallet limits** - Check mints per wallet server-side
3. **Show clear pricing** - Total including fees
4. **Handle all states** - Loading, success, error, sold out
5. **Link to explorer** - Let users verify transactions
