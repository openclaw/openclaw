# Transaction Patterns Reference

Detailed transaction patterns for Solana with Phantom Connect SDKs.

## Solana Transactions

### Dependencies

```bash
npm install @solana/web3.js
# OR for newer @solana/kit
npm install @solana/kit
```

### SOL Transfer with @solana/web3.js

```ts
import {
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";

async function transferSol(solana, recipient: string, lamports: number) {
  // Use "https://api.devnet.solana.com" for testing
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const { blockhash } = await connection.getLatestBlockhash();

  const fromAddress = await solana.getPublicKey();

  const message = new TransactionMessage({
    payerKey: new PublicKey(fromAddress),
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: new PublicKey(fromAddress),
        toPubkey: new PublicKey(recipient),
        lamports,
      }),
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  const result = await solana.signAndSendTransaction(transaction);

  return result.hash;
}

// Usage: 0.001 SOL = 1,000,000 lamports
const txHash = await transferSol(solana, "recipient-address", 1000000);
```

### SOL Transfer with @solana/kit

```ts
import {
  createSolanaRpc,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  address,
  compileTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

async function transferSolKit(solana, recipient: string, amountLamports: bigint) {
  const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const userPublicKey = await solana.getPublicKey();

  const transferIx = getTransferSolInstruction({
    source: address(userPublicKey),
    destination: address(recipient),
    amount: amountLamports,
  });

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(userPublicKey), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
  );

  const transaction = compileTransaction(transactionMessage);
  const result = await solana.signAndSendTransaction(transaction);

  return result.hash;
}
```

### SPL Token Transfer

```ts
import { Connection, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { getAssociatedTokenAddress, createTransferInstruction } from "@solana/spl-token";

async function transferToken(
  solana,
  mint: string,
  recipient: string,
  amount: number,
  decimals: number,
) {
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const { blockhash } = await connection.getLatestBlockhash();

  const fromAddress = await solana.getPublicKey();
  const fromPubkey = new PublicKey(fromAddress);
  const mintPubkey = new PublicKey(mint);
  const toPubkey = new PublicKey(recipient);

  const fromAta = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toAta = await getAssociatedTokenAddress(mintPubkey, toPubkey);

  const transferAmount = amount * Math.pow(10, decimals);

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [createTransferInstruction(fromAta, toAta, fromPubkey, transferAmount)],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  return await solana.signAndSendTransaction(transaction);
}
```

### Sign Without Sending

> **Warning:** `signTransaction` only works with the injected (extension) provider. It is NOT supported for embedded wallets (Google/Apple login). For embedded wallets, always use `signAndSendTransaction`.

```ts
// Sign only — INJECTED PROVIDER ONLY (not supported for embedded/Google/Apple wallets)
// For embedded wallets, always use signAndSendTransaction instead
const signedTx = await solana.signTransaction(transaction);

// Then send later
const connection = new Connection("https://api.mainnet-beta.solana.com");
const signature = await connection.sendRawTransaction(signedTx.serialize());
```

### Network Switching

```ts
// Switch networks before transactions
await solana.switchNetwork("devnet");
// Options: "mainnet-beta", "devnet", "testnet"
```

## Message Signing

```ts
// Sign a message
const message = "Hello World";
const { signature } = await solana.signMessage(message);
console.log("Signature:", signature);
```

## Error Handling

```ts
try {
  const result = await solana.signAndSendTransaction(transaction);
  console.log("Success:", result.hash);
} catch (error) {
  if (error.message.includes("User rejected")) {
    console.log("User cancelled the transaction");
  } else if (error.message.includes("insufficient funds")) {
    console.log("Not enough balance");
  } else {
    console.error("Transaction failed:", error);
  }
}
```

## Transaction Status Checking

```ts
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");

// Wait for confirmation
const confirmation = await connection.confirmTransaction(signature, "confirmed");

// Get transaction details
const txDetails = await connection.getTransaction(signature);
```

## Fee Estimation

```ts
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");

// Get recent prioritization fees
const fees = await connection.getRecentPrioritizationFees();

// Get minimum balance for rent exemption
const minBalance = await connection.getMinimumBalanceForRentExemption(dataSize);
```
