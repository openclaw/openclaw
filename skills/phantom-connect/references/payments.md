# Crypto Payments

Accept cryptocurrency payments in your applications.

## Simple SOL Payment

```tsx
import { useState } from "react";
import { useSolana, useAccounts } from "@phantom/react-sdk";
import { Connection, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage, LAMPORTS_PER_SOL } from "@solana/web3.js";

function PayButton({ recipient, amountSol }: { recipient: string; amountSol: number }) {
  const { solana } = useSolana();
  const { isConnected } = useAccounts();
  const [status, setStatus] = useState<"idle" | "paying" | "success" | "error">("idle");

  async function handlePay() {
    setStatus("paying");
    try {
      const connection = new Connection("https://api.mainnet-beta.solana.com");
      const { blockhash } = await connection.getLatestBlockhash();
      const wallet = await solana.getPublicKey();

      const message = new TransactionMessage({
        payerKey: new PublicKey(wallet),
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: new PublicKey(wallet),
            toPubkey: new PublicKey(recipient),
            lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
          }),
        ],
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);
      await solana.signAndSendTransaction(tx);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return (
    <button onClick={handlePay} disabled={!isConnected || status === "paying"}>
      {status === "paying" ? "Processing..." : `Pay ${amountSol} SOL`}
    </button>
  );
}
```

## SPL Token Payment (USDC)

```tsx
import { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, getAccount } from "@solana/spl-token";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function payWithUSDC(solana: any, recipient: string, amount: number) {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const { blockhash } = await connection.getLatestBlockhash();
  const wallet = await solana.getPublicKey();

  const mint = new PublicKey(USDC_MINT);
  const from = new PublicKey(wallet);
  const to = new PublicKey(recipient);

  const fromAta = await getAssociatedTokenAddress(mint, from);
  const toAta = await getAssociatedTokenAddress(mint, to);

  const instructions = [];

  // Create recipient's token account if needed
  try {
    await getAccount(connection, toAta);
  } catch {
    instructions.push(createAssociatedTokenAccountInstruction(from, toAta, to, mint));
  }

  // Transfer (USDC has 6 decimals)
  instructions.push(createTransferInstruction(fromAta, toAta, from, amount * 1e6));

  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  return await solana.signAndSendTransaction(new VersionedTransaction(message));
}
```

## Checkout with Backend Verification

### Client

```tsx
import { VersionedTransaction } from "@solana/web3.js";

async function checkout(orderId: string, solana: any) {
  // 1. Create payment on backend
  const { paymentId, transaction } = await fetch("/api/payments/create", {
    method: "POST",
    body: JSON.stringify({ orderId }),
  }).then(r => r.json());

  // 2. Deserialize and sign
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  const { hash } = await solana.signAndSendTransaction(tx);

  // 3. Confirm with backend
  const { success } = await fetch("/api/payments/confirm", {
    method: "POST",
    body: JSON.stringify({ paymentId, txHash: hash }),
  }).then(r => r.json());

  return success;
}
```

### Server

```ts
// /api/payments/create.ts
export async function POST(req: Request) {
  const { orderId } = await req.json();
  
  // Get order, calculate amount
  const order = await db.orders.findUnique({ where: { id: orderId } });
  const solAmount = order.total / await getSolPrice();
  
  // Create payment record
  const payment = await db.payments.create({
    data: { orderId, solAmount, status: "pending" }
  });

  // Build transaction (partial - user will sign)
  // Return serialized transaction
  
  return Response.json({ paymentId: payment.id, transaction: "..." });
}

// /api/payments/confirm.ts
export async function POST(req: Request) {
  const { paymentId, txHash } = await req.json();
  
  // Verify transaction on-chain
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const tx = await connection.getTransaction(txHash, { commitment: "confirmed" });
  
  if (!tx) return Response.json({ success: false });
  
  // Verify amount and recipient match
  // Update payment status
  // Fulfill order
  
  return Response.json({ success: true });
}
```

## Price Display with Live Rates

```tsx
import { useState, useEffect } from "react";

function PriceDisplay({ usdAmount }: { usdAmount: number }) {
  const [solPrice, setSolPrice] = useState(0);

  useEffect(() => {
    async function fetchPrice() {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      const data = await res.json();
      setSolPrice(data.solana.usd);
    }
    fetchPrice();
    const interval = setInterval(fetchPrice, 60000);
    return () => clearInterval(interval);
  }, []);

  const solAmount = solPrice ? (usdAmount / solPrice).toFixed(4) : "...";

  return (
    <div>
      <p>${usdAmount} USD</p>
      <p>≈ {solAmount} SOL</p>
    </div>
  );
}
```

## Best Practices

1. **Always verify on-chain** - Don't trust client-side alone
2. **Use unique payment IDs** - Track each payment
3. **Handle price volatility** - Lock prices or use stablecoins
4. **Set expiration** - Payment requests should expire
5. **Wait for confirmations** - Confirm before fulfilling
