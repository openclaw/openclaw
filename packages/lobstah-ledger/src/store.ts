import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SignedReceipt } from "@lobstah/protocol";

export const defaultLedgerPath = (): string =>
  process.env.LOBSTAH_LEDGER ?? join(homedir(), ".lobstah", "ledger.jsonl");

export const append = async (
  signed: SignedReceipt,
  path: string = defaultLedgerPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(signed)}\n`);
};

export const readAll = async (path: string = defaultLedgerPath()): Promise<SignedReceipt[]> => {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out: SignedReceipt[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as SignedReceipt);
    } catch {
      // skip malformed lines silently — corrupt rows shouldn't break the whole ledger
    }
  }
  return out;
};
