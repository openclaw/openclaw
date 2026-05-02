import { computeBalances, readAll } from "@lobstah/ledger";
import { formatPubkey, loadOrCreateIdentity } from "@lobstah/protocol";

export const balance = async (_args: string[]): Promise<void> => {
  const { identity } = await loadOrCreateIdentity();
  const ourPk = formatPubkey(identity.publicKey);

  const receipts = await readAll();
  const summary = computeBalances(receipts);

  const self = summary.perPeer.get(ourPk) ?? {
    pubkey: ourPk,
    earned: 0,
    spent: 0,
    net: 0,
  };

  const sign = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

  process.stdout.write(`balance for ${ourPk}\n`);
  process.stdout.write(`  earned (as worker):    ${self.earned} tokens\n`);
  process.stdout.write(`  spent  (as requester): ${self.spent} tokens\n`);
  process.stdout.write(`  net:                   ${sign(self.net)} tokens\n`);
  process.stdout.write("\nledger totals:\n");
  process.stdout.write(`  receipts: ${summary.totals.receipts}\n`);
  process.stdout.write(`  tokens:   ${summary.totals.earned}\n`);

  if (summary.perPeer.size > 1) {
    process.stdout.write("\nper peer:\n");
    for (const [pk, b] of summary.perPeer.entries()) {
      const tag = pk === ourPk ? " (you)" : "";
      process.stdout.write(`  ${pk}${tag}\n`);
      process.stdout.write(`    earned ${b.earned}, spent ${b.spent}, net ${sign(b.net)}\n`);
    }
  }
};
