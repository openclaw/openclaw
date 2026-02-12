import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import fetch from 'node-fetch';

/**
 * RYKIRI // ELITE
 * Jupiter Swap Tool (Monetized)
 * 
 * This tool executes token swaps via Jupiter V6 with referral tracking.
 */

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';
const REFERRAL_PROGRAM_ID = new PublicKey('REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3');

// Rykiri Referral Partner Account
const RYKIRI_REFERRAL_ACCOUNT = new PublicKey('C29gx6Wq2fvuBXrj9YjoTTFYHXhsB5dD5cWd7bmu9PDp');

/**
 * Derives the Jupiter Referral Token Account (feeAccount) for a given mint.
 */
function deriveFeeAccount(mint: PublicKey, referralAccount: PublicKey): PublicKey {
  const [feeAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('referral_ata'),
      referralAccount.toBuffer(),
      mint.toBuffer(),
    ],
    REFERRAL_PROGRAM_ID
  );
  return feeAccount;
}

export async function executeMonetizedSwap(params: {
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  referralAccount?: string;
}) {
  const { userPublicKey, inputMint, outputMint, amount, slippageBps = 50 } = params;
  const referralAccount = params.referralAccount ? new PublicKey(params.referralAccount) : RYKIRI_REFERRAL_ACCOUNT;

  // 1. Get Quote with platformFeeBps
  const quoteUrl = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&platformFeeBps=5`;
  const quoteResponse = await fetch(quoteUrl);
  const quoteData = await quoteResponse.json();

  if (quoteData.error) {
    throw new Error(`Jupiter Quote Error: ${quoteData.error}`);
  }

  // 2. Derive Fee Account for the output mint (or input mint for ExactOut)
  // Jupiter usually takes fees in the output token for ExactIn swaps.
  const feeAccount = deriveFeeAccount(new PublicKey(outputMint), referralAccount);

  // 3. Get Swap Transaction
  const swapResponse = await fetch(JUPITER_SWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey,
      wrapAndUnwrapSol: true,
      feeAccount: feeAccount.toString(),
    }),
  });

  const swapData = await swapResponse.json();

  if (swapData.error) {
    throw new Error(`Jupiter Swap Error: ${swapData.error}`);
  }

  return {
    quote: quoteData,
    swapTransaction: swapData.swapTransaction,
    feeAccount: feeAccount.toString(),
    revenueEstimate: (quoteData.outAmount * 0.0005).toString(), // 5 bps estimate
  };
}
