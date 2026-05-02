import { type SignedReceipt, totalTokens, verifyReceipt } from "@lobstah/protocol";

export type Balance = {
  pubkey: string;
  earned: number;
  spent: number;
  net: number;
};

export type BalanceTotals = {
  earned: number;
  spent: number;
  receipts: number;
};

export type BalanceSummary = {
  perPeer: Map<string, Balance>;
  totals: BalanceTotals;
};

const ensure = (m: Map<string, Balance>, pk: string): Balance => {
  let b = m.get(pk);
  if (!b) {
    b = { pubkey: pk, earned: 0, spent: 0, net: 0 };
    m.set(pk, b);
  }
  return b;
};

export const computeBalances = (signedReceipts: SignedReceipt[]): BalanceSummary => {
  const perPeer = new Map<string, Balance>();
  const totals: BalanceTotals = { earned: 0, spent: 0, receipts: 0 };
  for (const s of signedReceipts) {
    if (!verifyReceipt(s)) continue;
    const t = totalTokens(s.receipt);
    const worker = ensure(perPeer, s.receipt.workerPubkey);
    const requester = ensure(perPeer, s.receipt.requesterPubkey);
    worker.earned += t;
    worker.net += t;
    requester.spent += t;
    requester.net -= t;
    totals.earned += t;
    totals.spent += t;
    totals.receipts += 1;
  }
  return { perPeer, totals };
};
