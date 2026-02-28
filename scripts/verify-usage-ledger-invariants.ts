import path from "node:path";
import { verifyLedgerInvariants } from "../src/clarityburst/ledger-verification.js";

/**
 * CLI entrypoint for ledger verification.
 * Delegates to the programmatic API in src/clarityburst/ledger-verification.ts.
 */
async function verifyUsageLedgerInvariants() {
  const ledgerPath = path.join(process.cwd(), "docs/internal/clarityburst-usage-ledger.jsonl");

  // Call the programmatic API
  const result = await verifyLedgerInvariants(ledgerPath, 50);

  if (result.valid) {
    // Success: print summary and exit with 0
    console.log(`CLARITYBURST_LEDGER_OK checked=${result.entries_checked} window=${result.window_size}`);
    process.exit(0);
  } else {
    // Failure: print error details and exit with 1
    console.error(`${result.failure_reason}`);
    if (result.error_message) {
      console.error(`Details: ${result.error_message}`);
    }
    process.exit(1);
  }
}

verifyUsageLedgerInvariants().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
